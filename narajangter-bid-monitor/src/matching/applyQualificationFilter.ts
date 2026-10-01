import type { Env } from "../config/env.js";
import type { AppConfig } from "../config/loadJsonConfig.js";
import { fetchAllLicenseLimitGroups, type LicenseLimitGroup } from "../api/licenseLimitApi.js";
import { logger } from "../logger.js";
import { evaluateQualifications, missingLabels } from "./qualificationFilter.js";
import type { MatchedNotice } from "./types.js";

/**
 * 본공고 매칭 결과에 자격조건(면허제한) 판정을 붙인다.
 * 사전규격은 대응하는 면허제한 조회 API가 없어 이 판정 대상에서 제외한다(그대로 통과).
 *
 * **공고를 빼지 않는다.** 미보유 자격이 있어도 공동수급이 허용되면 그 자격을 가진 업체와 함께
 * 참가할 수 있어서, "미충족"으로 표시만 하고 판단은 담당자에게 맡긴다 (회사 방침, 2026-09-30).
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

  let missingCount = 0;
  // 조회가 실패하면 fetchAllLicenseLimitGroups가 빈 Map을 준다. 조회기간 전체에 면허제한
  // 공고가 한 건도 없을 리는 없으므로 빈 Map은 실패로 본다.
  const lookupFailed = groupsByNotice.size === 0;

  for (const match of matches) {
    const groups = groupsByNotice.get(match.notice.noticeNo) ?? [];
    if (groups.length === 0) {
      // 자격조건 정보가 없거나 전체조회 자체가 실패함
      match.qualification = { status: lookupFailed ? "조회실패" : "제한없음", totalGroups: 0, satisfiedBy: [], missing: [] };
      continue;
    }

    const result = evaluateQualifications(groups, appConfig.heldProducts, appConfig.heldIndustries);
    match.qualification = {
      status: result.passes ? "충족" : "미충족",
      totalGroups: result.totalGroups,
      satisfiedBy: result.satisfiedBy,
      missing: missingLabels(result.missingGroups),
    };
    if (!result.passes) missingCount += 1;
  }

  logger.info("자격조건 판정 완료", { 대상: matches.length, 미보유: missingCount });
  return matches;
}
