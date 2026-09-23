import { BID_NOTICE_FIELD_CANDIDATES } from "./fieldCandidates.js";
import { BID_NOTICE_OPERATIONS, DEFAULT_BID_NOTICE_BASE_URL } from "./endpoints.js";
import { dedupeNotices, fetchNoticesBySourceType } from "./fetchNotices.js";
import type { Env } from "../config/env.js";
import type { FetchResult, FetchWindow } from "./types.js";

/** 나라장터 입찰공고정보서비스 (본공고) - 물품/용역/공사 조회 */
export async function fetchBidNotices(env: Env, window: FetchWindow): Promise<FetchResult[]> {
  const results = await fetchNoticesBySourceType({
    sourceLabel: "본공고",
    sourceType: "본공고",
    baseUrl: env.naraBidBaseUrl ?? DEFAULT_BID_NOTICE_BASE_URL,
    serviceKey: env.naraBidServiceKey,
    operations: BID_NOTICE_OPERATIONS,
    fieldCandidates: BID_NOTICE_FIELD_CANDIDATES,
    window,
    numOfRows: env.apiNumOfRows,
    maxPages: env.apiMaxPages,
    timeoutMs: env.apiTimeoutMs,
    maxRetries: env.apiMaxRetries,
    retryDelayMs: env.apiRetryDelayMs,
    requestIntervalMs: env.apiRequestIntervalMs,
    pageConcurrency: env.apiPageConcurrency,
  });
  return dedupeNotices(results);
}
