import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";
import { toErrorMessage } from "../errors.js";
import { toApiDateTime } from "./dateUtil.js";
import type { RawItem } from "./fieldResolver.js";
import { fetchAllPages, fetchAllPagesInWindow, type ApiCallOptions } from "./httpClient.js";

/**
 * 목록 API를 "받아둔 것 + 그 뒤로 새로 올라온 것"으로 조회한다 (웹 UI의 "마감 전 공고 전체"용).
 *
 * 60일치 본공고를 매번 새로 받으면 3~4분이 걸리는데, 9월 초에 올라온 공고는 오늘 다시 받아도
 * 거의 그대로다. 그래서 한 번 받은 원본 행을 디스크에 두고, 다음 조회에서는 지난번 조회 끝
 * 시각부터 지금까지만 더 받아 합친다.
 *
 * 정정·취소 공고는 같은 공고번호에 차수를 올려 새로 게시되므로 추가분으로 들어오고,
 * 호출부의 "최신 차수만 남기기"(dedupeNotices, groupRawItemsByNotice)가 옛 차수를 가린다.
 * 그래도 게시 뒤에 조용히 고쳐진 행까지 따라잡도록 날짜가 바뀌면 한 번은 전체를 새로 받는다.
 *
 * 정기 발송(src/index.ts)은 쓰지 않는다 — 그쪽은 매번 새로 받아야 한다.
 */

const STORE_DIR = path.resolve(process.cwd(), "cache", "incremental");

export interface Store {
  /** 저장본이 덮는 조회 기간 */
  begin: string;
  end: string;
  /** 마지막으로 전체를 새로 받은 시각 */
  fullAt: string;
  items: RawItem[];
}

function storePath(options: ApiCallOptions): string {
  const key = createHash("sha1")
    .update(`${options.baseUrl}|${options.operation}|${JSON.stringify(options.params)}`)
    .digest("hex")
    .slice(0, 12);
  return path.join(STORE_DIR, `${options.operation}-${key}.json`);
}

async function loadStore(file: string): Promise<Store | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as Store;
  } catch {
    return null;
  }
}

async function saveStore(file: string, store: Store): Promise<void> {
  try {
    await mkdir(STORE_DIR, { recursive: true });
    // 쓰다 끊기면 다음 조회가 반쪽짜리 파일을 읽게 되므로 임시 파일에 쓰고 바꿔치기한다
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(store), "utf-8");
    await rename(tmp, file);
  } catch (err) {
    // 저장 실패는 다음 조회가 느려질 뿐 이번 결과에는 영향이 없다
    logger.warn("받아둔 공고 저장 실패 (다음 조회는 전체를 새로 받습니다)", { error: toErrorMessage(err) });
  }
}

/** 한국 날짜 (YYYYMMDD) */
const dayOf = (d: Date): string => toApiDateTime(d).slice(0, 8);

/**
 * 저장본으로 이번 조회를 이어 받을 수 있는지. 날짜가 바뀌었거나, 저장본이 이번 기간의 앞쪽을
 * 덮지 못하거나, 시계가 거꾸로 간 경우에는 전체를 새로 받는다.
 */
export function canContinue(store: Store | null, window: { begin: Date; end: Date }): store is Store {
  if (!store) return false;
  return (
    dayOf(new Date(store.fullAt)) === dayOf(window.end) &&
    new Date(store.begin).getTime() <= window.begin.getTime() &&
    new Date(store.end).getTime() <= window.end.getTime()
  );
}

export async function fetchAllPagesIncremental(
  options: ApiCallOptions,
  window: { begin: Date; end: Date },
  pageParams: Parameters<typeof fetchAllPages>[1]
): Promise<RawItem[]> {
  const file = storePath(options);
  const store = await loadStore(file);

  if (!canContinue(store, window)) {
    const items = await fetchAllPagesInWindow(options, window, pageParams);
    await saveStore(file, {
      begin: window.begin.toISOString(),
      end: window.end.toISOString(),
      fullAt: window.end.toISOString(),
      items,
    });
    logger.info(`${options.label} 전체 새로 받음`, { count: items.length });
    return items;
  }

  // 지난번 끝 시각(분)부터 다시 받는다. 경계 1분에 걸친 행은 두 번 오므로 똑같은 행은 하나만 남긴다.
  const fresh = await fetchAllPagesInWindow(options, { begin: new Date(store.end), end: window.end }, pageParams);
  const seen = new Set(store.items.map((item) => JSON.stringify(item)));
  const added = fresh.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const items = [...store.items, ...added];
  await saveStore(file, { ...store, end: window.end.toISOString(), items });
  logger.info(`${options.label} 받아둔 것에 이어 받음`, { 받아둔: store.items.length, 추가: added.length });
  return items;
}
