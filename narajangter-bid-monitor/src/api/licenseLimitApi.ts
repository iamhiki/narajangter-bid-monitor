import type { Env } from "../config/env.js";
import { LICENSE_LIMIT_FIELD_CANDIDATES } from "./fieldCandidates.js";
import { pickString, warnMissingFieldOnce, type RawItem } from "./fieldResolver.js";
import { fetchAllPages } from "./httpClient.js";
import { DEFAULT_BID_NOTICE_BASE_URL, LICENSE_LIMIT_OPERATION } from "./endpoints.js";
import { toApiDateTime } from "./dateUtil.js";
import { logger } from "../logger.js";
import { toErrorMessage } from "../errors.js";

/** 제한그룹 하나(=자격조건 하나). 그룹 내 항목 중 하나라도 우리가 보유하면 그 그룹은 충족된 것으로 본다. */
export interface LicenseLimitGroup {
  groupNo: string;
  /** 해당 그룹에서 허용되는 업종/면허명 목록 (이 중 하나라도 보유하면 충족) */
  allowedNames: string[];
}

/**
 * 허용업종목록 텍스트를 개별 업종명으로 분리한다.
 * 실측 결과 "[업종명/업종코드][업종명/업종코드]..." 형태의 대괄호 단위로 오는 것으로 확인되어
 * (예: "[축산물가공업(식육가공업)/4004]"), 대괄호 단위로 먼저 나누고 각 단위에서
 * 마지막 "/" 뒤의 코드를 떼어내 업종명만 남긴다. 대괄호가 없는 단순 나열 텍스트는
 * 기존처럼 콤마/슬래시로 분리한다.
 */
function splitList(text: string): string[] {
  const bracketed = [...text.matchAll(/\[([^\]]+)\]/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined);
  if (bracketed.length > 0) {
    return bracketed
      .map((entry) => {
        const slashIndex = entry.lastIndexOf("/");
        return (slashIndex === -1 ? entry : entry.slice(0, slashIndex)).trim();
      })
      .filter((s) => s.length > 0);
  }

  return text
    .split(/[,\/·、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 면허제한정보조회 원본 응답을 입찰공고번호별 제한그룹 목록으로 정리한다.
 *
 * 주의: 이 오퍼레이션은 bidNtceNo 파라미터를 서버가 필터링해주지 않고 조회기간 내 전체를
 * 페이지 단위로 내려준다(2026-07-28 실측 확인). 그래서 공고 1건씩 호출하는 대신
 * 조회기간 전체를 한 번에 받아 여기서 공고번호별로 묶어 로컬에서 조회하는 방식으로 설계했다.
 */
export function groupRawItemsByNotice(rawItems: RawItem[]): Map<string, LicenseLimitGroup[]> {
  const byNotice = new Map<string, Map<string, string[]>>();

  for (const item of rawItems) {
    const noticeNo = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.noticeNo);
    const groupNo = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.groupNo);
    if (!noticeNo || !groupNo) {
      warnMissingFieldOnce("면허제한정보", "noticeNo/groupNo", Object.keys(item));
      continue;
    }

    const names: string[] = [];
    const licenseLimitName = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.licenseLimitName);
    if (licenseLimitName) names.push(licenseLimitName);
    const allowedIndustryList = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.allowedIndustryList);
    if (allowedIndustryList) names.push(...splitList(allowedIndustryList));

    if (names.length === 0) {
      warnMissingFieldOnce("면허제한정보", "licenseLimitName/allowedIndustryList", Object.keys(item));
      continue;
    }

    const groupsForNotice = byNotice.get(noticeNo) ?? new Map<string, string[]>();
    groupsForNotice.set(groupNo, [...(groupsForNotice.get(groupNo) ?? []), ...names]);
    byNotice.set(noticeNo, groupsForNotice);
  }

  const result = new Map<string, LicenseLimitGroup[]>();
  for (const [noticeNo, groupsForNotice] of byNotice) {
    result.set(
      noticeNo,
      [...groupsForNotice.entries()].map(([groupNo, allowedNames]) => ({ groupNo, allowedNames }))
    );
  }
  return result;
}

/**
 * 조회기간 내 전체 면허제한정보를 한 번에 받아 입찰공고번호별로 정리해 반환한다.
 * 조회 실패 시 예외 없이 빈 Map을 반환한다 (호출측에서 fail-open 정책으로 처리하기 위함).
 */
/**
 * 같은 조회기간을 반복해서 받아오지 않도록 하는 프로세스 내 캐시.
 *
 * 이 조회는 공고 몇 건을 거르려고 조회기간 전체(8천여 건)를 받아오는 구조라 제일 오래 걸린다.
 * 정기 실행은 프로세스가 한 번 돌고 끝나서 캐시가 의미 없지만, 텔레그램 봇처럼 떠 있는
 * 프로세스에서 /report를 연달아 칠 때는 매번 30초를 다시 기다리게 된다.
 *
 * 공고의 참가자격은 게시 후 자주 바뀌는 값이 아니라 짧은 TTL이면 충분하고,
 * TTL이 지나면 그냥 다시 받는다.
 */
const LICENSE_CACHE_TTL_MS = 10 * 60 * 1000;
let licenseCache: { key: string; fetchedAt: number; groups: Map<string, LicenseLimitGroup[]> } | null = null;

/** 테스트에서 캐시를 리셋하기 위한 헬퍼 */
export function _resetLicenseLimitCacheForTests(): void {
  licenseCache = null;
}

export async function fetchAllLicenseLimitGroups(env: Env, window: { begin: Date; end: Date }): Promise<Map<string, LicenseLimitGroup[]>> {
  // 캐시 키를 조회 창의 "길이"로 잡는다.
  // 시작·종료 시각을 그대로 쓰면 toApiDateTime이 분 단위라 1분만 지나도 키가 달라져
  // 캐시가 사실상 한 번도 맞지 않는다. 창의 시작점은 매 호출마다 몇 분씩 밀릴 뿐
  // 같은 기간을 보는 것이고, 캐시에 없는 공고는 fail-open(그대로 통과)으로 처리되므로
  // 몇 분 어긋나도 결과가 틀어지지 않는다.
  const spanDays = Math.round((window.end.getTime() - window.begin.getTime()) / 86_400_000);
  const cacheKey = `span-${spanDays}d`;
  if (licenseCache && licenseCache.key === cacheKey && Date.now() - licenseCache.fetchedAt < LICENSE_CACHE_TTL_MS) {
    logger.info("면허제한정보 캐시 사용", {
      공고수: licenseCache.groups.size,
      경과초: Math.round((Date.now() - licenseCache.fetchedAt) / 1000),
    });
    return licenseCache.groups;
  }

  try {
    const rawItems = await fetchAllPages(
      {
        baseUrl: env.naraBidBaseUrl ?? DEFAULT_BID_NOTICE_BASE_URL,
        operation: LICENSE_LIMIT_OPERATION,
        serviceKey: env.naraBidServiceKey,
        params: {
          inqryDiv: "1",
          inqryBgnDt: toApiDateTime(window.begin),
          inqryEndDt: toApiDateTime(window.end),
        },
        timeoutMs: env.apiTimeoutMs,
        maxRetries: env.apiMaxRetries,
        retryDelayMs: env.apiRetryDelayMs,
        label: "면허제한정보",
      },
      {
        numOfRows: env.apiNumOfRows,
        maxPages: env.apiMaxPages,
        requestIntervalMs: env.apiRequestIntervalMs,
        pageConcurrency: env.apiPageConcurrency,
      }
    );

    logger.info("면허제한정보 전체 조회 완료", { rawCount: rawItems.length });
    const groups = groupRawItemsByNotice(rawItems);
    licenseCache = { key: cacheKey, fetchedAt: Date.now(), groups };
    return groups;
  } catch (err) {
    logger.warn("면허제한정보 조회 실패 (자격조건 필터를 건너뛰고 모두 통과시킴)", { error: toErrorMessage(err) });
    return new Map();
  }
}
