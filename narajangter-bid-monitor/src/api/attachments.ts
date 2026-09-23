import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
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

/**
 * 과업 내용이 담긴 문서의 파일명 패턴.
 *
 * 입찰공고문·계약정보요약서·내역서는 제외한다 — 행정 절차와 금액표만 있고 과업 내용이
 * 없어서, 넣으면 모든 공고가 같은 행정 문구로 서로 비슷해진다(불용어와 같은 문제).
 */
const SPEC_PATTERN = /과업|제안요청|요청서|과업내용|시방|규격서/;
const EXCLUDE_PATTERN = /내역서|산출|계약정보요약|낙찰자|유의서|청렴|서식|양식/;

/** 우리가 텍스트를 뽑을 수 있는 형식만 받는다. */
const SUPPORTED = /\.(hwp|hwpx|pdf)$/i;

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
    const normalized = name.replace(/[_\-.]+/g, " ");
    out.push({
      name,
      url,
      isSpec: SPEC_PATTERN.test(normalized) && !EXCLUDE_PATTERN.test(normalized),
    });
  }
  return out;
}

/** 과업 내용이 담긴 첨부만, 우선순위대로. */
export function pickSpecAttachments(notice: NormalizedNotice): NoticeAttachment[] {
  const specs = listAttachments(notice).filter((a) => a.isSpec);
  // 과업지시서 > 제안요청서 > 나머지. 과업지시서가 과업 내용을 가장 직접적으로 담는다.
  const rank = (name: string): number => (/과업지시|과업내용/.test(name) ? 0 : /제안요청|요청서/.test(name) ? 1 : 2);
  return specs.sort((a, b) => rank(a.name) - rank(b.name));
}

export interface DownloadOptions {
  /** 캐시 디렉터리. null이면 캐시하지 않는다. */
  cacheDir?: string | null;
  timeoutMs?: number;
  /** 이 크기를 넘으면 받지 않는다 (기본 40MB). 스캔 PDF가 100MB를 넘는 경우가 있다. */
  maxBytes?: number;
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
    const limit = options.maxBytes ?? 40 * 1024 * 1024;
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
