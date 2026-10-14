import type { Env } from "../config/env.js";
import { pickString, type RawItem } from "./fieldResolver.js";
import { fetchAllPagesInWindow, type ApiCallOptions } from "./httpClient.js";
import { fetchAllPagesIncremental } from "./incrementalFetch.js";
import { DEFAULT_BID_NOTICE_BASE_URL, PARTICIPATION_REGION_OPERATION } from "./endpoints.js";
import { logger } from "../logger.js";
import { toErrorMessage } from "../errors.js";

/**
 * 참가가능지역정보 원본 응답을 입찰공고번호별 참가 가능 지역 목록으로 정리한다.
 *
 * 실측 응답(2026-10-14): { bidNtceNo, bidNtceOrd, lmtSno, prtcptPsblRgnNm: "경상남도" | "강원특별자치도 횡성군", ... }
 * 한 공고에 순번(lmtSno)이 여러 개면 그중 어느 지역이든 참가할 수 있다 ("서울특별시"/"경기도").
 * 정정공고는 차수마다 다시 실리므로 공고마다 가장 최신 차수만 쓴다 (licenseLimitApi와 같은 이유).
 */
export function groupRegionsByNotice(rawItems: RawItem[]): Map<string, string[]> {
  const latestOrd = new Map<string, string>();
  for (const item of rawItems) {
    const noticeNo = pickString(item, ["bidNtceNo"]);
    const ord = pickString(item, ["bidNtceOrd"]) ?? "";
    if (noticeNo && ord >= (latestOrd.get(noticeNo) ?? "")) latestOrd.set(noticeNo, ord);
  }

  const result = new Map<string, string[]>();
  for (const item of rawItems) {
    const noticeNo = pickString(item, ["bidNtceNo"]);
    const region = pickString(item, ["prtcptPsblRgnNm"]);
    if (!noticeNo || !region) continue;
    if ((pickString(item, ["bidNtceOrd"]) ?? "") !== latestOrd.get(noticeNo)) continue;
    const regions = result.get(noticeNo) ?? [];
    if (!regions.includes(region)) regions.push(region);
    result.set(noticeNo, regions);
  }
  return result;
}

const REGION_CACHE_TTL_MS = 10 * 60 * 1000;
let regionCache: { key: string; fetchedAt: number; regions: Map<string, string[]> } | null = null;

function regionCallOptions(env: Env): ApiCallOptions {
  return {
    baseUrl: env.naraBidBaseUrl ?? DEFAULT_BID_NOTICE_BASE_URL,
    operation: PARTICIPATION_REGION_OPERATION,
    serviceKey: env.naraBidServiceKey,
    params: { inqryDiv: "1" },
    timeoutMs: env.apiTimeoutMs,
    maxRetries: env.apiMaxRetries,
    retryDelayMs: env.apiRetryDelayMs,
    label: "참가가능지역",
  };
}

function regionPageParams(env: Env) {
  return {
    numOfRows: env.apiNumOfRows,
    maxPages: env.apiMaxPages,
    requestIntervalMs: env.apiRequestIntervalMs,
    pageConcurrency: env.apiPageConcurrency,
  };
}

/** 테스트에서 캐시를 리셋하기 위한 헬퍼 */
export function _resetRegionLimitCacheForTests(): void {
  regionCache = null;
}

/**
 * 조회기간 내 전체 참가가능지역정보를 받아 입찰공고번호별로 정리한다.
 * 조회 실패 시 예외 없이 빈 Map을 반환한다 — 지역으로 거르지 않고 모두 통과시킨다 (fail-open).
 * 캐시·이어받기는 fetchAllLicenseLimitGroups와 같은 방식이다.
 */
export async function fetchAllParticipationRegions(
  env: Env,
  window: { begin: Date; end: Date },
  options: { incremental?: boolean } = {}
): Promise<Map<string, string[]>> {
  if (options.incremental) {
    try {
      return groupRegionsByNotice(await fetchAllPagesIncremental(regionCallOptions(env), window, regionPageParams(env)));
    } catch (err) {
      logger.warn("참가가능지역 조회 실패 (지역제한 필터를 건너뛰고 모두 통과시킴)", { error: toErrorMessage(err) });
      return new Map();
    }
  }

  const spanDays = Math.round((window.end.getTime() - window.begin.getTime()) / 86_400_000);
  const cacheKey = `span-${spanDays}d`;
  if (regionCache && regionCache.key === cacheKey && Date.now() - regionCache.fetchedAt < REGION_CACHE_TTL_MS) {
    return regionCache.regions;
  }

  try {
    const rawItems = await fetchAllPagesInWindow(regionCallOptions(env), window, regionPageParams(env));
    logger.info("참가가능지역 전체 조회 완료", { rawCount: rawItems.length });
    const regions = groupRegionsByNotice(rawItems);
    regionCache = { key: cacheKey, fetchedAt: Date.now(), regions };
    return regions;
  } catch (err) {
    logger.warn("참가가능지역 조회 실패 (지역제한 필터를 건너뛰고 모두 통과시킴)", { error: toErrorMessage(err) });
    return new Map();
  }
}
