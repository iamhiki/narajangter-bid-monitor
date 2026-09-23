import { openSync, readSync, closeSync } from "node:fs";
import { extname } from "node:path";
import { extractHwpText } from "./hwpText.js";
import { extractHwpxText, stripImageNoise } from "./hwpxText.js";
import { isOcrAvailable, ocrPdf, type OcrOptions } from "./ocr.js";
import { extractPdfPages, findScannedPages } from "./pdfText.js";
import type { ExtractResult } from "./types.js";

/** PDF를 만났을 때 OCR을 어디까지 쓸 것인가. */
export type OcrMode =
  /** OCR 안 씀. 텍스트 레이어만 읽는다 (기본값 — 정기 실행·CI용) */
  | "off"
  /** 텍스트 레이어가 비어 있는 페이지만 OCR (권장) */
  | "auto"
  /** 텍스트 레이어를 무시하고 전 페이지 OCR (검증·비교용) */
  | "force";

export interface ExtractOptions {
  ocr?: OcrMode;
  ocrOptions?: OcrOptions;
  /** PDF에서 읽을 최대 페이지 수. 0이면 전부. */
  maxPages?: number;
}

/**
 * 과업지시서/제안요청서 1개 파일 → 본문 텍스트.
 *
 * 지원: .hwp(바이너리 OLE), .hwpx(zip+XML), .pdf(텍스트 레이어 + 선택적 OCR).
 *
 * PDF는 두 단계로 처리한다. 먼저 내장 텍스트 레이어를 읽고, 글자가 없는 페이지만 골라
 * OCR에 넘긴다(`ocr: "auto"`). 수행능력평가서처럼 앞쪽 서식은 텍스트이고 뒤쪽 증명서는
 * 스캔인 혼합 문서가 많아서, 통짜로 OCR하면 107쪽을 전부 돌려 1분을 버린다.
 *
 * 기본값이 `"off"`인 이유: OCR은 Windows 전용이고 페이지당 0.4~0.9초가 든다. 주간 리포트
 * 같은 정기 실행 경로에서 기본으로 켜지면 GitHub Actions에서 조용히 실패하거나 느려진다.
 * 필요한 쪽(로컬 배치 스크립트)에서 명시적으로 켜도록 했다.
 */
export async function extractDocumentText(
  filePath: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const format = detectFormat(filePath);

  if (format === "pdf") return extractPdfDocument(filePath, options);

  const raw =
    format === "hwpx"
      ? extractHwpxText(filePath)
      : format === "hwp"
        ? extractHwpText(filePath)
        : { text: "", reason: `지원하지 않는 형식: ${extname(filePath) || "(확장자 없음)"}` };

  if (raw.text.length === 0) return raw;
  return { text: normalizeWhitespace(stripImageNoise(raw.text)), reason: raw.reason };
}

async function extractPdfDocument(filePath: string, options: ExtractOptions): Promise<ExtractResult> {
  const mode = options.ocr ?? "off";

  if (mode === "force") {
    if (!isOcrAvailable()) return { text: "", reason: "OCR 강제 모드지만 이 환경에서는 OCR을 쓸 수 없음" };
    const ocr = await ocrPdf(filePath, { ...options.ocrOptions, maxPages: options.maxPages ?? 0 });
    if (ocr.error) return { text: "", reason: `OCR 실패: ${ocr.error}` };
    const text = joinPages(ocr.pages);
    return {
      text: normalizeWhitespace(text),
      reason: text.length === 0 ? "OCR 결과가 비어 있음" : `전 페이지 OCR (${ocr.pages.length}쪽${ocr.fromCache ? ", 캐시" : ""})`,
    };
  }

  const layer = await extractPdfPages(filePath, { maxPages: options.maxPages ?? 0 });
  if (layer.pageCount === 0) return { text: "", reason: layer.reason };

  const scanned = findScannedPages(layer.pages);

  if (mode === "off" || scanned.length === 0 || !isOcrAvailable()) {
    const note =
      scanned.length > 0 && mode !== "off" && !isOcrAvailable()
        ? `스캔 추정 ${scanned.length}/${layer.pageCount}쪽은 건너뜀 (이 환경에서 OCR 불가)`
        : scanned.length > 0
          ? `스캔 추정 ${scanned.length}/${layer.pageCount}쪽은 건너뜀 (ocr: "auto"로 켤 수 있음)`
          : layer.reason;
    if (layer.text.length === 0) return { text: "", reason: note ?? "텍스트 없음" };
    return { text: normalizeWhitespace(layer.text), reason: note };
  }

  // auto: 글자가 없던 페이지만 OCR해서 텍스트 레이어 결과와 합친다.
  const ocr = await ocrPdf(filePath, { ...options.ocrOptions, onlyPages: scanned });
  if (ocr.error) {
    const text = normalizeWhitespace(layer.text);
    return { text, reason: `텍스트 레이어만 사용 (OCR 실패: ${ocr.error})` };
  }

  const byPage = new Map<number, string>();
  for (const p of layer.pages) if (p.text.length > 0) byPage.set(p.page, p.text);
  for (const p of ocr.pages) if (p.text.length > 0) byPage.set(p.page, p.text);

  const merged = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("\n");
  // 처리한 쪽수는 layer.pages.length다. layer.pageCount(문서 전체 쪽수)를 쓰면
  // --pages=12로 앞 12쪽만 읽었는데 "텍스트 95쪽"이라고 나온다.
  return {
    text: normalizeWhitespace(merged),
    reason: `텍스트 ${layer.pages.length - scanned.length}쪽 + OCR ${ocr.pages.length}쪽${ocr.fromCache ? " (캐시)" : ""}`,
  };
}

function joinPages(pages: { page: number; text: string }[]): string {
  return [...pages]
    .sort((a, b) => a.page - b.page)
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join("\n");
}

/**
 * 파일 **내용**으로 형식을 판별한다. 확장자를 믿지 않는 이유가 실제로 있다:
 * 아카이브의 `2025_강릉아레나` 제안요청서는 확장자가 `.hwp`인데 내용은 hwpx(zip)다.
 * 한글에서 "다른 이름으로 저장" 할 때 형식과 확장자가 어긋나면 이런 파일이 생기고,
 * 확장자만 보고 분기하면 그 사업 1건이 통째로 본문 없이 남는다.
 *
 * 매직바이트: zip은 "PK\x03\x04", OLE 복합문서는 D0 CF 11 E0 A1 B1 1A E1.
 */
export function detectFormat(filePath: string): "hwp" | "hwpx" | "pdf" | "unknown" {
  const header = readHeaderBytes(filePath, 8);
  if (header) {
    // "%PDF"
    if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) return "pdf";
    if (header[0] === 0x50 && header[1] === 0x4b) return "hwpx";
    if (header[0] === 0xd0 && header[1] === 0xcf && header[2] === 0x11 && header[3] === 0xe0) return "hwp";
  }
  // 내용을 못 읽었을 때만 확장자로 떨어진다.
  const ext = extname(filePath).toLowerCase();
  if (ext === ".hwpx") return "hwpx";
  if (ext === ".hwp") return "hwp";
  if (ext === ".pdf") return "pdf";
  return "unknown";
}

function readHeaderBytes(filePath: string, length: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return read === length ? buffer : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** 줄바꿈은 살리고 그 외 공백만 줄인다 — 항목 구분이 사라지면 사업명 추출이 어려워진다. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t 　]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 과업지시서 첫머리의 "사 업 명 / 과 업 명" 항목에서 정식 사업명을 뽑는다.
 *
 * 한글 문서는 항목명을 글자 사이 공백으로 늘려 쓰는 관행이 있어("사 업 명") 공백을
 * 허용해야 하고, 값이 콜론 뒤 같은 줄에 오기도 하고 다음 줄에 오기도 한다. 둘 다 받는다.
 */
export function extractOfficialName(body: string): string | null {
  const label = /(?:^|\n)\s*(?:[가-힣]\.|\d+\.)?\s*[사과]\s*업\s*(?:명|의\s*명칭)\s*(?::|：)?\s*(.*)/;
  const match = label.exec(body);
  if (!match) return null;

  let value = (match[1] ?? "").trim();
  // 같은 줄이 비어 있으면 (예: "1. 과 업 명" 다음 줄에 값) 다음 비어 있지 않은 줄을 본다.
  if (value.length === 0) {
    const rest = body.slice(match.index + match[0].length);
    const nextLine = rest.split("\n").find((line) => line.trim().length > 0);
    value = (nextLine ?? "").trim();
  }

  value = value
    .replace(/^[:：\-–—]\s*/, "")
    .replace(/[「」『』【】《》]/g, "")
    .replace(/\s*\(.*?\)\s*$/, "")
    .trim();

  // 너무 짧으면 라벨만 걸린 것이고, 너무 길면 문단을 통째로 집은 것이다 — 둘 다 버린다.
  if (value.length < 4 || value.length > 120) return null;
  // 같은 줄이 비어 다음 줄을 집었는데 그 줄이 또 다른 항목 라벨인 경우가 있다
  // ("1. 과 업 명" 바로 아래가 "2. 과업 기간"). 사업명 자리에 "과업 기간"이 들어가면
  // 그 사업은 엉뚱한 이름으로 코퍼스에 남으므로 차라리 폴더명을 쓰는 게 낫다.
  if (LABEL_LIKE.test(value)) return null;
  // 사업명 자리에 문장이 들어온 경우를 막는다. 과업지시서에는
  // `… 사업명은 "○○ 용역" 이라 한다.` 같은 정의 문장이 흔한데, 그대로 집으면
  // 코퍼스에 `"은 본리미리내어린이공원 … 용역 이라 한다."`가 사업명으로 남는다(실측).
  if (SENTENCE_LIKE.test(value)) return null;
  // 표로 짜인 과업지시서에서는 `사 업 명` 칸 옆에 발주부서가 오는 경우가 있다.
  // 실측: `하동공설시장 편의시설 키즈카페 기구 제작·설치` 문서에서 사업명 자리에
  // `하동군 경제도시국 경제기업과`가 잡혔다. 기관·부서 이름은 사업명이 아니다.
  if (ORGANIZATION_LIKE.test(value) && !PROJECT_WORDS.test(value)) return null;
  return value;
}

/** 부서·기관 이름으로 끝나면 사업명이 아닐 가능성이 크다. */
const ORGANIZATION_LIKE = /(?:과|국|부|실|팀|청|원|처|센터)\s*$/;
/** 사업명이라면 거의 항상 들어가는 말 — 이게 있으면 기관명처럼 끝나도 사업명으로 본다. */
const PROJECT_WORDS = /설계|제작|설치|조성|구축|리모델링|개선|정비|공모|납품|연출|디자인|용역|공사/;

/** 조사로 시작하거나 서술어로 끝나면 사업명이 아니라 문장을 집은 것이다. */
const SENTENCE_LIKE = /^(?:은|는|이|가|을|를|의|에|로|와|과)\s|(?:이라|라고)?\s*한다\.?$|다\.$/;

/** 과업지시서 항목 라벨 형태 — 사업명이 아니라 옆 항목을 집었다는 신호. */
const LABEL_LIKE =
  /^(?:\d+\.|[가-힣]\.)?\s*(?:[사과]\s*업\s*)?(?:기\s*간|장\s*소|위\s*치|목\s*적|개\s*요|범\s*위|비|예\s*산|금\s*액|내\s*용|방\s*법|조\s*건)\s*$/;

/**
 * 총사업비(원)를 뽑는다. "총사업비 : 금1,700,000,000원", "사 업 비 / 총 620,000,000원" 등.
 *
 * 문서 전체에서 제일 큰 숫자를 찾는 방식은 쓰지 않는다 — 면적(㎡)·연도·전화번호·
 * 세부 단가표까지 걸려서 엉뚱한 값이 잡힌다. 사업비 라벨 뒤 400자 안에서만 찾는다.
 */
export function extractBudgetAmount(body: string): number | null {
  const label = /(?:총\s*)?[사과]\s*업\s*비|총\s*사\s*업\s*비|사업예산|추정가격|사업금액/;
  const match = label.exec(body);
  if (!match) return null;

  const window = body.slice(match.index, match.index + 400);
  const amount = /([0-9]{1,3}(?:,[0-9]{3}){2,})\s*원/.exec(window);
  if (!amount?.[1]) return null;

  const value = Number(amount[1].replace(/,/g, ""));
  // 1천만원 미만이면 사업비가 아니라 단가·수수료를 잘못 집은 것으로 본다.
  return Number.isFinite(value) && value >= 10_000_000 ? value : null;
}
