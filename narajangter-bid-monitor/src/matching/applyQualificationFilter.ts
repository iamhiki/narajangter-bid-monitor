import type { Env } from "../config/env.js";
import type { AppConfig } from "../config/loadJsonConfig.js";
import { fetchAllLicenseLimitGroups, type LicenseLimitGroup } from "../api/licenseLimitApi.js";
import { logger } from "../logger.js";
import { evaluateQualifications } from "./qualificationFilter.js";
import type { MatchedNotice } from "./types.js";

/**
 * 본공고 매칭 결과에 자격조건(면허제한) 필터를 적용한다.
 * 사전규격은 대응하는 면허제한 조회 API가 없어 이 필터 대상에서 제외한다(그대로 통과).
 */
export async function applyQualificationFilter(
  env: Env,
  appConfig: AppConfig,
  matches: MatchedNotice[],
  window: { begin: Date; end: Date },
  /**
   * 이미 시작해둔 면허제한정보 조회. 이 조회는 어떤 공고가 매칭됐는지와 무관하게
   * 조회기간 전체를 받아오므로, 공고 조회와 **동시에** 시작할 수 있다.
   * 넘기지 않으면 여기서 직접 받아온다(기존 동작).
   */
  licenseGroupsPromise?: Promise<Map<string, LicenseLimitGroup[]>>
): Promise<MatchedNotice[]> {
  if (matches.length === 0) return matches;

  const groupsByNotice = await (licenseGroupsPromise ?? fetchAllLicenseLimitGroups(env, window));

  const kept: MatchedNotice[] = [];
  let excludedCount = 0;

  for (const match of matches) {
    const groups = groupsByNotice.get(match.notice.noticeNo) ?? [];
    if (groups.length === 0) {
      // 자격조건 정보가 없거나 전체조회 자체가 실패함 -> fail-open (통과)
      kept.push(match);
      continue;
    }

    const result = evaluateQualifications(groups, appConfig.heldProducts, appConfig.heldIndustries);
    if (result.passes) {
      kept.push(match);
    } else {
      excludedCount += 1;
      logger.debug("자격조건 부족으로 제외", {
        noticeNo: match.notice.noticeNo,
        title: match.notice.title,
        missingCount: result.missingCount,
        totalGroups: result.totalGroups,
      });
    }
  }

  logger.info("자격조건 필터 적용 완료", { 대상: matches.length, 통과: kept.length, 제외: excludedCount });
  return kept;
}
