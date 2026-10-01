import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import type { NormalizedNotice } from "./types.js";
import { logger } from "../logger.js";

/**
 * 공고 첨부파일(과업지시서·제안요청서) 다운로드.
 *
 * **스크래핑이 아니다.** 나라장터 OpenAPI 응답에 첨부파일 이름과 직접 다운로드 URL이
 * 이미 들어 있다 — `ntceSpecFileNm1~10`, `ntceSpecDocUrl1~10`. 실측으로 확인했고
 * (2026-09-22) 인증·세션·쿠키 없이 그냥 GET으로 받아진다.
 *
 * 왜 필요한가: OpenAPI가 주는 공고 본문은 제목 한 줄뿐이라 ④ 싱크로율의 질의가
 * 20자짜리 문자열이었다. 첨부 과업지시서를 읽으면 질의가 과업개요·추진배경·과업범위
 * 전체로 바뀐다. 다만 실측상 매칭 공고 20건 중 **5건**만 과업지시서류를 붙이고 있어서,
 * 전 건이 아니라 4건 중 1건 정도가 혜택을 본다.
 */

export interface NoticeAttachment {
  name: string;
  url: string;
  /** 과업 내용이 담긴 문서인가 (입찰공고문·내역서 등과 구분) */
  isSpec: boolean;
}

/** 텍스트를 뽑을 문서 하나. ZIP 첨부는 안에 든 문서마다 하나씩 나온다. */
export interface AttachmentDocument {
  /** 화면·로그에 쓸 이름. ZIP 안 문서는 "묶음.zip › 제안요청서.hwpx" */
  name: string;
  path: string;
}

/**
 * 과업 내용이 담긴 문서의 파일명 패턴.
 *
 * 입찰공고문·계약정보요약서·내역서는 제외한다 — 행정 절차와 금액표만 있고 과업 내용이
 * 없어서, 넣으면 모든 공고가 같은 행정 문구로 서로 비슷해진다(불용어와 같은 문제).
 */
const SPEC_PATTERN = /과업|제안요청|요청서|과업내용|시방|규격서/;
const EXCLUDE_PATTERN = /내역서|산출|계약정보요약|낙찰자|유의서|청렴|서식|양식/;

/** 우리가 텍스트를 뽑을 수 있는 형식만 받는다. */
const DOCUMENT = /\.(hwp|hwpx|pdf)$/i;
/**
 * ZIP도 받는다 — 국립중앙박물관처럼 제안요청서를 "제안요청서 등.zip"에만 넣는 기관이 있다.
 * 2026-10-01 실측: 리스트에 남은 특별전 9건 중 3건의 제안요청서가 ZIP 안에만 있었다.
 */
const SUPPORTED = /\.(hwp|hwpx|pdf|zip)$/i;
const ARCHIVE = /\.zip$/i;

/** 응답 항목에서 첨부파일 목록을 뽑는다. 최대 10개 슬롯이 규격이다. */
export function listAttachments(notice: NormalizedNotice): NoticeAttachment[] {
  const raw = notice.raw as Record<string, unknown> | undefined;
  if (!raw) return [];

  const out: NoticeAttachment[] = [];
  for (let i = 1; i <= 10; i++) {
    const name = String(raw[`ntceSpecFileNm${i}`] ?? "").trim();
    const url = String(raw[`ntceSpecDocUrl${i}`] ?? "").trim();
    if (!name || !url) continue;
    if (!SUPPORTED.test(name)) continue;
    out.push({ name, url, isSpec: isSpecName(name) || (ARCHIVE.test(name) && !isExcludedName(name)) });
  }
  return out;
}

const normalizeName = (name: string) => name.replace(/[_\-.]+/g, " ");
const isExcludedName = (name: string) => EXCLUDE_PATTERN.test(normalizeName(name));
/** 파일명으로 본 과업 문서 여부. ZIP은 이름이 "첨부.zip"처럼 막연해도 과업 문서를 묶어 두는 경우가 많아 따로 받는다. */
export function isSpecName(name: string): boolean {
  const normalized = normalizeName(name);
  return SPEC_PATTERN.test(normalized) && !EXCLUDE_PATTERN.test(normalized);
}

/** 과업지시서 > 제안요청서 > 나머지. 과업지시서가 과업 내용을 가장 직접적으로 담는다. 같은 순위면 ZIP을 뒤로. */
export function specRank(name: string): number {
  const base = /과업지시|과업내용/.test(name) ? 0 : /제안요청|요청서/.test(name) ? 1 : 2;
  return base + (ARCHIVE.test(name) ? 0.5 : 0);
}

/** 과업 내용이 담긴 첨부만, 우선순위대로. */
export function pickSpecAttachments(notice: NormalizedNotice): NoticeAttachment[] {
  return listAttachments(notice)
    .filter((a) => a.isSpec)
    .sort((a, b) => specRank(a.name) - specRank(b.name));
}

/**
 * ZIP 안 파일명 복원. 한국 관공서 ZIP은 대부분 UTF-8 표시 없이 CP949로 이름을 넣어서,
 * fflate가 latin1로 읽은 "Á¦¾È¿äÃ»¼­"를 바이트로 되돌려 EUC-KR로 다시 읽는다.
 */
function decodeEntryName(name: string): string {
  if ([...name].some((c) => c.charCodeAt(0) > 0xff)) return name; // 이미 UTF-8로 읽힘
  try {
    const decoded = new TextDecoder("euc-kr", { fatal: true }).decode(Uint8Array.from(name, (c) => c.charCodeAt(0)));
    return decoded;
  } catch {
    return name;
  }
}

/**
 * ZIP을 풀어 안의 hwp·hwpx·pdf를 꺼낸다. `<zip 경로>.d/`에 풀어 두고 다음부터는 다시 풀지 않는다.
 * 과업 문서로 보이는 이름을 앞에 둔다. 압축이 깨졌으면 빈 배열.
 */
export function expandArchive(zipPath: string, zipName: string, maxBytes?: number): AttachmentDocument[] {
  const dir = `${zipPath}.d`;
  const indexPath = join(dir, "index.json");
  let entries: { name: string; file: string }[];
  if (existsSync(indexPath)) {
    entries = JSON.parse(readFileSync(indexPath, "utf8"));
  } else {
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(new Uint8Array(readFileSync(zipPath)), {
        // 문서만 푼다 — 작품 목록 엑셀(58MB)·도면 같은 큰 파일을 메모리에 올리지 않는다.
        filter: (f) => DOCUMENT.test(decodeEntryName(f.name)) && f.originalSize <= (maxBytes ?? defaultMaxBytes(decodeEntryName(f.name))),
      });
    } catch (err) {
      logger.warn("ZIP 첨부를 풀지 못했습니다", { file: zipName, error: String(err) });
      return [];
    }
    mkdirSync(dir, { recursive: true });
    entries = Object.entries(unzipped).map(([raw, data], i) => {
      const name = decodeEntryName(raw).split("/").pop()!;
      const file = `${i}${extname(name).toLowerCase()}`;
      writeFileSync(join(dir, file), data);
      return { name, file };
    });
    writeFileSync(indexPath, JSON.stringify(entries), "utf8");
  }
  return entries
    .sort((a, b) => specRank(a.name) - specRank(b.name))
    .map((e) => ({ name: `${zipName} › ${e.name}`, path: join(dir, e.file) }));
}

/** 첨부 하나를 받아 텍스트를 뽑을 문서 목록으로 만든다 (ZIP이면 풀어서). 실패하면 빈 배열. */
export async function downloadDocuments(attachment: NoticeAttachment, options: DownloadOptions = {}): Promise<AttachmentDocument[]> {
  const path = await downloadAttachment(attachment, options);
  if (!path) return [];
  if (ARCHIVE.test(attachment.name)) return expandArchive(path, attachment.name, options.maxBytes);
  return [{ name: attachment.name, path }];
}

export interface DownloadOptions {
  /** 캐시 디렉터리. null이면 캐시하지 않는다. */
  cacheDir?: string | null;
  timeoutMs?: number;
  /** 이 크기를 넘으면 받지 않는다 (기본: PDF·HWP 40MB, HWPX·ZIP 150MB). 스캔 PDF가 100MB를 넘는 경우가 있다. */
  maxBytes?: number;
}

/**
 * HWPX·ZIP은 사진이 많으면 커지지만 우리는 안의 본문 XML·문서만 꺼낸다 — 2026-10-01 실측:
 * 지심도 산마루문화놀이터 과업내용서 HWPX가 80MB라 40MB 제한에 걸려 과업을 못 읽었다.
 * 스캔 PDF는 OCR을 끈 정기 실행에선 어차피 글자가 없어 받아도 쓸모가 없으니 40MB를 유지한다.
 */
function defaultMaxBytes(name: string): number {
  return /\.(hwpx|zip)$/i.test(name) ? 150 * 1024 * 1024 : 40 * 1024 * 1024;
}

/**
 * 첨부파일 하나를 받아 로컬 경로를 돌려준다. 실패하면 null.
 *
 * 캐시 키에 URL 해시를 쓴다 — 같은 공고가 정정공고로 다시 올라오면 URL이 바뀌므로
 * 자동으로 새로 받는다. 파일명만으로 키를 만들면 옛 버전을 계속 쓰게 된다.
 */
export async function downloadAttachment(
  attachment: NoticeAttachment,
  options: DownloadOptions = {}
): Promise<string | null> {
  const cacheDir = options.cacheDir === null ? null : (options.cacheDir ?? "cache/attachments");
  const ext = extname(attachment.name).toLowerCase() || ".bin";
  const key = createHash("sha1").update(attachment.url).digest("hex").slice(0, 16);
  const path = cacheDir ? resolve(join(cacheDir, `${key}${ext}`)) : null;

  if (path && existsSync(path)) return path;

  try {
    const res = await fetch(attachment.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      logger.warn("첨부파일 다운로드 실패", { file: attachment.name, status: res.status });
      return null;
    }

    const declared = Number(res.headers.get("content-length") ?? "0");
    const limit = options.maxBytes ?? defaultMaxBytes(attachment.name);
    if (declared > limit) {
      logger.warn("첨부파일이 너무 커서 건너뜁니다", { file: attachment.name, bytes: declared });
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > limit) {
      logger.warn("첨부파일이 너무 커서 건너뜁니다", { file: attachment.name, bytes: buffer.length });
      return null;
    }
    // 서버가 오류 페이지(HTML)를 200으로 돌려주는 경우가 있어 앞부분을 확인한다.
    if (buffer.subarray(0, 5).toString("latin1").toLowerCase().startsWith("<html")) {
      logger.warn("첨부파일 대신 HTML이 왔습니다", { file: attachment.name });
      return null;
    }

    if (!path) {
      // 캐시를 끄면 임시 경로에 쓴다 — 추출기가 파일 경로를 받기 때문이다.
      const temp = resolve(join("cache", "tmp", `${key}${ext}`));
      mkdirSync(dirname(temp), { recursive: true });
      writeFileSync(temp, buffer);
      return temp;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buffer);
    return path;
  } catch (err) {
    logger.warn("첨부파일 다운로드 중 오류", { file: attachment.name, error: String(err) });
    return null;
  }
}

/** 캐시에 이미 받아둔 파일인지 (진행 표시용) */
export function isCached(attachment: NoticeAttachment, cacheDir = "cache/attachments"): boolean {
  const ext = extname(attachment.name).toLowerCase() || ".bin";
  const key = createHash("sha1").update(attachment.url).digest("hex").slice(0, 16);
  return existsSync(resolve(join(cacheDir, `${key}${ext}`)));
}

/** 캐시된 파일 내용을 직접 읽어야 할 때 (진단용) */
export function readCached(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
