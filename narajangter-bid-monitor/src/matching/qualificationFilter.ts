import type { LicenseLimitGroup } from "../api/licenseLimitApi.js";
import type { CodeEntry } from "../config/loadJsonConfig.js";

/**
 * 공고의 업종제한과 지일 보유 자격을 대조한다.
 *
 * **코드로 맞춘다.** 이전 구현은 업종 *이름*의 부분일치로 판정했는데, 그게 오탐의 원인이었다:
 *   공고 제한 `건축공사업(0002)`  ↔  보유 `실내건축공사업(0006)`
 *   → "실내건축공사업".includes("건축공사업") 이 참이라 **충족으로 판정**됐다.
 * 두 업종은 전혀 다른 면허이고, 지일은 0002를 보유하지 않는다. 실제로 이 탓에
 * 건축공사업 제한이 걸린 710억 건물 신축공사가 그대로 통과했다.
 *
 * 코드는 4자리 숫자라 부분일치 여지가 없다. 허용업종 문자열이 `업종명/코드` 형태로
 * 오므로(실측: `"정보통신공사업/0036"`) 코드를 떼어 비교한다.
 */

/**
 * 부족해도 통과시킬 자격조건 그룹 수.
 *
 * **0이다.** 이전 값은 1이었는데, 실측하면 면허제한이 걸린 공고의 **72%(12,377/17,262건)가
 * 그룹 1개짜리**다. 1개까지 봐준다는 건 그 72%에 대해 필터가 아무 일도 안 한다는 뜻이었다.
 * 실제로 "식품판매업만 허용"하는 공고가 `부족 1/1`인데도 통과했다.
 *
 * 그룹은 AND 조건이다 — 공고가 여러 그룹을 걸면 전부 충족해야 참가할 수 있다.
 * 하나라도 못 채우면 입찰 자체가 불가능하므로 봐줄 이유가 없다.
 */
export const MAX_ALLOWED_MISSING_QUALIFICATIONS = 0;

export interface QualificationCheckResult {
  totalGroups: number;
  missingGroups: LicenseLimitGroup[];
  missingCount: number;
  /** 부족한 자격조건 개수가 허용 범위 이내인지 여부 */
  passes: boolean;
  /** 코드를 못 읽어 이름으로 판정할 수밖에 없었던 그룹 수 (진단용) */
  nameFallbackGroups: number;
}

/** `"정보통신공사업/0036"` → `"0036"`. 코드가 없으면 null. */
export function extractCode(allowedName: string): string | null {
  const match = /\/\s*(\d{4})\s*$/.exec(allowedName.trim());
  return match?.[1] ?? null;
}

/**
 * 그룹 하나가 충족되는지 본다. 그룹 안의 허용업종은 OR 조건이다 — 하나만 보유하면 된다.
 *
 * 코드가 붙어 있으면 코드로만 판정한다. 코드가 전혀 없는 그룹(식품위생법상 영업 종류처럼
 * 업종코드 체계가 아닌 경우)에서만 이름 완전일치로 떨어진다 — 부분일치는 쓰지 않는다.
 */
export function isGroupSatisfied(
  group: LicenseLimitGroup,
  heldCodes: ReadonlySet<string>,
  heldNames: ReadonlySet<string>
): { satisfied: boolean; usedNameFallback: boolean } {
  let sawCode = false;

  for (const allowed of group.allowedNames) {
    const code = extractCode(allowed);
    if (code) {
      sawCode = true;
      if (heldCodes.has(code)) return { satisfied: true, usedNameFallback: false };
    }
  }
  if (sawCode) return { satisfied: false, usedNameFallback: false };

  // 코드가 하나도 없는 그룹 — 이름 완전일치로만 본다.
  const bare = group.allowedNames.map((n) => n.trim());
  const satisfied = bare.some((n) => heldNames.has(n));
  return { satisfied, usedNameFallback: true };
}

/**
 * 공고의 자격조건(제한그룹) 목록과 보유 자격을 대조한다.
 * 그룹이 없으면(=자격조건 정보가 없거나 조회 실패) 항상 통과시킨다 (fail-open).
 */
export function evaluateQualifications(
  groups: LicenseLimitGroup[],
  heldProducts: CodeEntry[],
  heldIndustries: CodeEntry[]
): QualificationCheckResult {
  const heldCodes = new Set([...heldProducts, ...heldIndustries].map((c) => c.code.trim()));
  const heldNames = new Set([...heldProducts, ...heldIndustries].map((c) => c.name.trim()));

  const missingGroups: LicenseLimitGroup[] = [];
  let nameFallbackGroups = 0;

  for (const group of groups) {
    const { satisfied, usedNameFallback } = isGroupSatisfied(group, heldCodes, heldNames);
    if (usedNameFallback) nameFallbackGroups += 1;
    if (!satisfied) missingGroups.push(group);
  }

  return {
    totalGroups: groups.length,
    missingGroups,
    missingCount: missingGroups.length,
    passes: missingGroups.length <= MAX_ALLOWED_MISSING_QUALIFICATIONS,
    nameFallbackGroups,
  };
}
