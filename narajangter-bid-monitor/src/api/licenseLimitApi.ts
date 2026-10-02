import type { Env } from "../config/env.js";
import { LICENSE_LIMIT_FIELD_CANDIDATES } from "./fieldCandidates.js";
import { pickString, warnMissingFieldOnce, type RawItem } from "./fieldResolver.js";
import { fetchAllPagesInWindow, type ApiCallOptions } from "./httpClient.js";
import { fetchAllPagesIncremental } from "./incrementalFetch.js";
import { DEFAULT_BID_NOTICE_BASE_URL, LICENSE_LIMIT_OPERATION } from "./endpoints.js";
import { logger } from "../logger.js";
import { toErrorMessage } from "../errors.js";

/**
 * 제한그룹 하나 = 참가 방법 하나.
 *
 * 나라장터 규칙 (2026-09-30 공고문 원문으로 확인 — 가양4단지 주차장 신설공사 R26BK01745222):
 *   "다음 각 호 중 어느 하나에 해당하는 … 1) 토목공사업 또는 토목건축공사업을 등록한 자
 *    2) 지반조성·포장공사업과 상하수도설비공사업을 모두 등록한 자"
 *   API: 그룹1 순번1 토목공사업(허용 토목건축공사업) / 그룹2 순번1 상하수도설비 / 그룹2 순번2 지반조성·포장
 * → **그룹끼리는 "또는"**(하나만 채우면 참가 가능), **그룹 안 순번끼리는 "그리고"**(모두 필요),
 *   한 순번 안의 허용업종은 그 업종 대신 인정되는 것("또는").
 * 나라장터 화면도 그룹 두 개를 "[건축공사업(0002)] 업종 또는 [토목건축공사업(0003)] 업종"으로 보여준다.
 */
export interface LicenseLimitGroup {
  groupNo: string;
  /** 표시용: 그룹에 나오는 업종/면허명 전부 (rows를 펼친 것) */
  allowedNames: string[];
  /**
   * 순번별 요건. 순번마다 [제한업종, ...허용업종] — 순번끼리는 모두 필요, 한 순번 안은 하나만 있으면 된다.
   * 없으면 allowedNames 전체를 순번 하나로 본다.
   */
  rows?: string[][];
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
    // "업종명/코드" 그대로 둔다 — 판정은 코드로 한다(qualificationFilter.extractCode). 예전에는 코드를
    // 떼어 이름만 남겼는데, 그러면 제한업종에 코드가 있는 순번에서 허용업종이 판정에 쓰이지 않았다
    // (허용 토목건축공사업/0003을 보유해도 건축공사업/0002 순번을 못 채운 것으로 나옴).
    return bracketed.map((entry) => entry.trim()).filter((s) => s.length > 0);
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
  // 정정공고는 차수(bidNtceOrd 000·001·002)마다 같은 요건을 다시 싣는다. 합치면 순번이 겹쳐 요건이
  // 부풀려지므로 공고마다 가장 최신 차수만 쓴다.
  const latestOrd = new Map<string, string>();
  for (const item of rawItems) {
    const noticeNo = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.noticeNo);
    const ord = pickString(item, ["bidNtceOrd"]) ?? "";
    if (noticeNo && ord > (latestOrd.get(noticeNo) ?? "")) latestOrd.set(noticeNo, ord);
  }

  const byNotice = new Map<string, Map<string, Map<string, string[]>>>();

  for (const item of rawItems) {
    const noticeNo = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.noticeNo);
    const groupNo = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.groupNo);
    if (!noticeNo || !groupNo) {
      warnMissingFieldOnce("면허제한정보", "noticeNo/groupNo", Object.keys(item));
      continue;
    }
    if ((pickString(item, ["bidNtceOrd"]) ?? "") !== (latestOrd.get(noticeNo) ?? "")) continue;
    // 순번이 없으면(실측상 항상 있음) 예전처럼 그룹 전체를 순번 하나로 본다
    const seqNo = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.seqNo) ?? "";

    const names: string[] = [];
    const licenseLimitName = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.licenseLimitName);
    if (licenseLimitName) names.push(licenseLimitName);
    const allowedIndustryList = pickString(item, LICENSE_LIMIT_FIELD_CANDIDATES.allowedIndustryList);
    if (allowedIndustryList) names.push(...splitList(allowedIndustryList));

    if (names.length === 0) {
      warnMissingFieldOnce("면허제한정보", "licenseLimitName/allowedIndustryList", Object.keys(item));
      continue;
    }

    const groupsForNotice = byNotice.get(noticeNo) ?? new Map<string, Map<string, string[]>>();
    const rowsForGroup = groupsForNotice.get(groupNo) ?? new Map<string, string[]>();
    rowsForGroup.set(seqNo, [...(rowsForGroup.get(seqNo) ?? []), ...names]);
    groupsForNotice.set(groupNo, rowsForGroup);
    byNotice.set(noticeNo, groupsForNotice);
  }

  const result = new Map<string, LicenseLimitGroup[]>();
  for (const [noticeNo, groupsForNotice] of byNotice) {
    result.set(
      noticeNo,
      [...groupsForNotice.entries()].map(([groupNo, rowsForGroup]) => {
        const rows = [...rowsForGroup.values()];
        return { groupNo, allowedNames: rows.flat(), rows };
      })
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

function licenseCallOptions(env: Env): ApiCallOptions {
  return {
    baseUrl: env.naraBidBaseUrl ?? DEFAULT_BID_NOTICE_BASE_URL,
    operation: LICENSE_LIMIT_OPERATION,
    serviceKey: env.naraBidServiceKey,
    params: { inqryDiv: "1" },
    timeoutMs: env.apiTimeoutMs,
    maxRetries: env.apiMaxRetries,
    retryDelayMs: env.apiRetryDelayMs,
    label: "면허제한정보",
  };
}

function licensePageParams(env: Env) {
  return {
    numOfRows: env.apiNumOfRows,
    maxPages: env.apiMaxPages,
    requestIntervalMs: env.apiRequestIntervalMs,
    pageConcurrency: env.apiPageConcurrency,
  };
}

/** 테스트에서 캐시를 리셋하기 위한 헬퍼 */
export function _resetLicenseLimitCacheForTests(): void {
  licenseCache = null;
}

export async function fetchAllLicenseLimitGroups(
  env: Env,
  window: { begin: Date; end: Date },
  options: { incremental?: boolean } = {}
): Promise<Map<string, LicenseLimitGroup[]>> {
  if (options.incremental) {
    // 받아둔 것에 이어 받기는 디스크 저장본이 대신하므로 아래 메모리 캐시는 건너뛴다.
    // 메모리 캐시를 타면 10분 동안 새로 올라온 공고의 참가자격을 못 보게 된다.
    try {
      const rawItems = await fetchAllPagesIncremental(licenseCallOptions(env), window, licensePageParams(env));
      return groupRawItemsByNotice(rawItems);
    } catch (err) {
      logger.warn("면허제한정보 조회 실패 (자격조건 필터를 건너뛰고 모두 통과시킴)", { error: toErrorMessage(err) });
      return new Map();
    }
  }

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
    const rawItems = await fetchAllPagesInWindow(licenseCallOptions(env), window, licensePageParams(env));

    logger.info("면허제한정보 전체 조회 완료", { rawCount: rawItems.length });
    const groups = groupRawItemsByNotice(rawItems);
    licenseCache = { key: cacheKey, fetchedAt: Date.now(), groups };
    return groups;
  } catch (err) {
    logger.warn("면허제한정보 조회 실패 (자격조건 필터를 건너뛰고 모두 통과시킴)", { error: toErrorMessage(err) });
    return new Map();
  }
}
