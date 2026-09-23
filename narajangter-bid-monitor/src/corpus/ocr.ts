import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

/**
 * 스캔된 PDF를 Windows 내장 OCR로 읽는다.
 *
 * 래스터화(Windows.Data.Pdf)와 문자인식(Windows.Media.Ocr) 둘 다 Windows 10/11에
 * 들어 있어서 설치할 게 없다 — tesseract도, 한국어 학습데이터도, ghostscript도 필요 없다.
 * 실측으로 한국어 인식이 되는 것을 확인했고(이 PC 기준 `ko` 지원), 페이지당 0.4~0.9초,
 * 문자 정확도는 대략 90~95%다.
 *
 * **정확도 주의**: 키워드 탐지("직접생산확인증명서가 들어 있는가")에는 충분하지만
 * 숫자 필드에는 오류가 섞인다 — 실측에서 `무릉2로`→`무름2로`, `2012.09.17`→`2912.0917`
 * 같은 오인식이 나왔다. 등록번호·유효기간·금액을 OCR 결과에서 그대로 확정하면 안 되고
 * 사람이 검수해야 한다.
 *
 * **Windows 전용**: GitHub Actions(ubuntu)에서는 동작하지 않는다. 그래서 정기 실행 경로에는
 * 넣지 않고, 로컬에서 1회성 배치로 돌리는 용도로만 쓴다. 다른 OS에서는 isOcrAvailable()이
 * false를 돌려주고 호출부는 조용히 건너뛴다.
 */

export interface OcrPageResult {
  page: number;
  text: string;
  error?: string;
}

export interface OcrResult {
  pageCount: number;
  pages: OcrPageResult[];
  /** 전체 실패 사유. 성공이면 null. */
  error: string | null;
  /** 캐시에서 읽었는지 (진단·진행표시용) */
  fromCache: boolean;
}

export interface OcrOptions {
  /** OCR할 페이지 번호(1-base). 비우면 startPage/maxPages 범위를 쓴다. */
  onlyPages?: number[];
  startPage?: number;
  maxPages?: number;
  /** 래스터화 가로 픽셀. 작으면 빠르지만 작은 글씨를 놓친다. */
  width?: number;
  language?: string;
  /** 캐시 디렉터리. 기본 cache/ocr */
  cacheDir?: string | null;
  timeoutMs?: number;
}

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "recognize-pdf.ps1");

/** OCR을 쓸 수 있는 환경인가 (Windows + 워커 스크립트 존재) */
export function isOcrAvailable(): boolean {
  return process.platform === "win32" && existsSync(SCRIPT_PATH);
}

/**
 * 캐시 키는 파일 경로 + 크기 + 수정시각 + OCR 옵션으로 만든다.
 *
 * OCR은 107쪽 문서 하나에 1분 가까이 걸린다. 같은 파일을 두 번 읽는 일이 없도록 캐시를
 * 두되, 파일이 바뀌면(크기·수정시각) 자동으로 무효가 되게 한다. 내용 해시를 쓰지 않는 이유는
 * 94MB짜리 PDF를 캐시 확인할 때마다 통째로 읽어야 해서 캐시의 이점이 사라지기 때문이다.
 */
function cacheKey(filePath: string, options: OcrOptions): string {
  let stamp = "";
  try {
    const stat = statSync(filePath);
    stamp = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    stamp = "unknown";
  }
  const shape = JSON.stringify({
    pages: options.onlyPages ?? null,
    start: options.startPage ?? 1,
    max: options.maxPages ?? 0,
    width: options.width ?? 2000,
    lang: options.language ?? "ko",
  });
  return createHash("sha1").update(`${resolve(filePath)}|${stamp}|${shape}`).digest("hex");
}

export async function ocrPdf(filePath: string, options: OcrOptions = {}): Promise<OcrResult> {
  if (!isOcrAvailable()) {
    return {
      pageCount: 0,
      pages: [],
      error: process.platform === "win32" ? `OCR 워커 스크립트 없음: ${SCRIPT_PATH}` : `OCR 미지원 플랫폼: ${process.platform}`,
      fromCache: false,
    };
  }

  const cacheDir = options.cacheDir === null ? null : (options.cacheDir ?? "cache/ocr");
  const cacheFile = cacheDir ? join(cacheDir, `${cacheKey(filePath, options)}.json`) : null;

  if (cacheFile && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as Omit<OcrResult, "fromCache">;
      return { ...cached, fromCache: true };
    } catch {
      // 캐시가 깨졌으면 무시하고 다시 돌린다.
    }
  }

  // PowerShell 결과는 표준출력이 아니라 파일로 받는다. 표준출력은 콘솔 코드페이지를 타서
  // 한글이 깨지는데(실측: `PDF 珥?107履?`), 파일로 UTF-8을 쓰면 그 문제가 없다.
  const outFile = join(tmpdir(), `ocr-${createHash("sha1").update(`${filePath}${Date.now()}`).digest("hex").slice(0, 16)}.json`);

  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    SCRIPT_PATH,
    "-Path",
    resolve(filePath),
    "-Out",
    outFile,
    "-Width",
    String(options.width ?? 2000),
    "-Language",
    options.language ?? "ko",
  ];
  if (options.onlyPages && options.onlyPages.length > 0) {
    args.push("-OnlyPages", options.onlyPages.join(","));
  } else {
    args.push("-StartPage", String(options.startPage ?? 1), "-MaxPages", String(options.maxPages ?? 0));
  }

  try {
    await execFileAsync("powershell.exe", args, {
      timeout: options.timeoutMs ?? 30 * 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    // 스크립트가 결과 파일을 남겼다면 그걸 우선 믿는다 (경고성 stderr로도 여기 올 수 있다).
    if (!existsSync(outFile)) {
      return { pageCount: 0, pages: [], error: `PowerShell 실행 실패: ${String(err)}`, fromCache: false };
    }
  }

  if (!existsSync(outFile)) {
    return { pageCount: 0, pages: [], error: "OCR 결과 파일이 생성되지 않음", fromCache: false };
  }

  let parsed: Omit<OcrResult, "fromCache">;
  try {
    parsed = JSON.parse(readFileSync(outFile, "utf8")) as Omit<OcrResult, "fromCache">;
  } catch (err) {
    return { pageCount: 0, pages: [], error: `OCR 결과 파싱 실패: ${String(err)}`, fromCache: false };
  } finally {
    try {
      unlinkSync(outFile);
    } catch {
      /* 임시파일 정리 실패는 무시 */
    }
  }

  // ConvertTo-Json은 항목이 하나뿐이면 배열이 아니라 객체로 내보낸다. 여기서 모양을 맞춰둔다.
  if (parsed.pages && !Array.isArray(parsed.pages)) parsed.pages = [parsed.pages as unknown as OcrPageResult];
  if (!parsed.pages) parsed.pages = [];

  if (cacheFile && parsed.error === null) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(parsed), "utf8");
    } catch (err) {
      logger.warn("OCR 캐시 저장 실패 (결과는 그대로 사용합니다)", { error: String(err) });
    }
  }

  return { ...parsed, fromCache: false };
}

/** OCR 결과를 한 덩어리 텍스트로 합친다 (페이지 순서대로). */
export function joinOcrPages(result: OcrResult): string {
  return [...result.pages]
    .sort((a, b) => a.page - b.page)
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join("\n");
}
