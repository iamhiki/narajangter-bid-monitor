import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { NormalizedNotice } from "./types.js";
import type { NoticeAttachment } from "./attachments.js";
import { DEFAULT_PRE_STANDARD_BASE_URL, PRE_STANDARD_OPERATIONS } from "./endpoints.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../logger.js";

/**
 * 본공고에 연결된 사전규격의 첨부 (규격서·제안요청서).
 *
 * 조달청이 집행하는 공고는 본공고 첨부가 "입찰공고서" 한 장뿐이고, 제안요청서는 앞서 올린 사전규격에만
 * 붙어 있는 경우가 많다. 공고서 본문에도 "규격서(제안요청서 포함) 등을 반드시 열람"이라고만 적혀 있다.
 * 본공고 응답의 bfSpecRgstNo가 그 사전규격 등록번호이고, 사전규격정보서비스를 inqryDiv=2로 조회하면
 * 첨부 URL(specDocFileUrl1~)을 준다 (2026-10-13 실측: R26BK01689798 서울대 공과대학 역사관 상설전시
 * → R26BD00264040 → 첨부 1건). 같은 날 제목만으로 싱크로율을 매긴 25건 중 6건이 이 경우였다.
 *
 * 조회 결과는 캐시에 둔다 — 사전규격 첨부는 본공고가 나온 뒤 바뀌지 않는다.
 */

const CACHE_PATH = resolve("cache/linked-prestandard.json");
let cache: Record<string, string[]> | null = null;

function loadCache(): Record<string, string[]> {
  if (cache) return cache;
  try {
    cache = existsSync(CACHE_PATH) ? (JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, string[]>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache(): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache ?? {}, null, 1), "utf8");
  } catch (err) {
    logger.warn("연결 사전규격 캐시를 저장하지 못했습니다", { error: String(err) });
  }
}

export function linkedPreStandardNo(notice: NormalizedNotice): string | null {
  if (notice.sourceType !== "본공고") return null;
  const raw = (notice.raw ?? {}) as Record<string, unknown>;
  const no = String(raw.bfSpecRgstNo ?? "").trim();
  return /^R\d{2}BD\d+$/.test(no) ? no : null;
}

/** 응답 항목에서 첨부 URL만 */
export function specUrlsOf(item: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const url = String(item[`specDocFileUrl${i}`] ?? "").trim();
    if (url) urls.push(url);
  }
  return urls;
}

async function lookup(regNo: string, notice: NormalizedNotice): Promise<string[] | null> {
  let env;
  try {
    env = loadEnv();
  } catch {
    return null;
  }
  if (!env.naraPrestdServiceKey) return null;
  const base = env.naraPrestdBaseUrl ?? DEFAULT_PRE_STANDARD_BASE_URL;
  // 본공고 업무구분과 사전규격 업무구분이 다른 경우가 있어(물품 공고 ← 용역 사전규격) 같은 구분부터 차례로 본다
  const ops = [PRE_STANDARD_OPERATIONS[notice.businessType], ...Object.values(PRE_STANDARD_OPERATIONS)].filter(
    (op, i, all) => op && all.indexOf(op) === i
  );
  for (const op of ops) {
    const url = new URL(`${base}/${op}`);
    url.searchParams.set("serviceKey", env.naraPrestdServiceKey);
    url.searchParams.set("type", "json");
    url.searchParams.set("numOfRows", "5");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("inqryDiv", "2");
    url.searchParams.set("bfSpecRgstNo", regNo);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(env.apiTimeoutMs ?? 20_000) });
      if (!res.ok) return null;
      const json = (await res.json()) as { response?: { body?: { items?: unknown } } };
      const items = json.response?.body?.items;
      const list = (Array.isArray(items) ? items : items && typeof items === "object" ? [(items as { item?: unknown }).item ?? items].flat() : []) as Record<string, unknown>[];
      const item = list.find((i) => String(i.bfSpecRgstNo ?? "") === regNo);
      if (item) return specUrlsOf(item);
    } catch (err) {
      logger.warn("연결 사전규격 조회 실패", { regNo, error: String(err) });
      return null;
    }
  }
  return [];
}

/** 연결된 사전규격의 첨부. 연결이 없거나 조회에 실패하면 빈 배열 (실패는 캐시하지 않아 다음에 다시 본다). */
export async function linkedPreStandardAttachments(notice: NormalizedNotice): Promise<NoticeAttachment[]> {
  const regNo = linkedPreStandardNo(notice);
  if (!regNo) return [];
  const store = loadCache();
  let urls = store[regNo];
  if (!urls) {
    const found = await lookup(regNo, notice);
    if (found === null) return [];
    urls = found;
    store[regNo] = urls;
    saveCache();
  }
  return urls.map((url, i) => ({ name: `연결 사전규격 첨부 ${i + 1}`, url, isSpec: true }));
}
