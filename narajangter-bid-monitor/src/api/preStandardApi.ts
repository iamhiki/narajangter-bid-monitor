import { PRE_STANDARD_FIELD_CANDIDATES } from "./fieldCandidates.js";
import { DEFAULT_PRE_STANDARD_BASE_URL, PRE_STANDARD_OPERATIONS } from "./endpoints.js";
import { dedupeNotices, fetchNoticesBySourceType } from "./fetchNotices.js";
import type { Env } from "../config/env.js";
import type { FetchResult, FetchWindow } from "./types.js";

/** 나라장터 사전규격정보서비스 (사전규격) - 물품/용역/공사 조회 */
export async function fetchPreStandardNotices(env: Env, window: FetchWindow): Promise<FetchResult[]> {
  const results = await fetchNoticesBySourceType({
    sourceLabel: "사전규격",
    sourceType: "사전규격",
    baseUrl: env.naraPrestdBaseUrl ?? DEFAULT_PRE_STANDARD_BASE_URL,
    serviceKey: env.naraPrestdServiceKey,
    operations: PRE_STANDARD_OPERATIONS,
    fieldCandidates: PRE_STANDARD_FIELD_CANDIDATES,
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
