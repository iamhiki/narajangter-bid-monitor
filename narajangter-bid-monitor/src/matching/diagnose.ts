import type { NormalizedNotice } from "../api/types.js";
import type { LicenseLimitGroup } from "../api/licenseLimitApi.js";
import type { AppConfig } from "../config/loadJsonConfig.js";
import { classifyBidMethod } from "./bidMethod.js";
import { matchCodes } from "./codeMatcher.js";
import { isDeadlinePassed } from "./deadline.js";
import { matchExcludeKeyword, matchKeywords } from "./keywordMatcher.js";
import { detectOverseasVenue } from "./overseasVenueFilter.js";
import { evaluateQualifications, uniqueSatisfied } from "./qualificationFilter.js";

/**
 * 공고 한 건이 수집 파이프라인의 각 단계를 통과했는지 하나씩 짚는다 (② 정제 · ③ 미수집 원인 파악용).
 *
 * matchEngine.evaluateNotice는 첫 번째로 걸리는 조건에서 바로 null을 돌려줘서 "왜 빠졌는지"를
 * 남기지 않는다. 여기서는 **모든 단계를 끝까지 다 돌린다** — 제외 키워드에도 걸리고 1억 미만이기도
 * 한 공고라면 둘 다 보여야, 제외 키워드 하나만 고쳐서는 여전히 안 잡힌다는 걸 알 수 있다.
 *
 * 단계 순서는 pipeline.ts의 실제 적용 순서와 같다. 판정 자체는 matchEngine과 같은 함수들을 쓰고,
 * 두 결과가 어긋나지 않는지는 test/diagnose.test.ts가 검사한다.
 */

export const DIAGNOSE_STEPS = [
  "마감",
  "제외키워드",
  "최소예산",
  "낙찰방법",
  "해외개최",
  "키워드·품목",
  "참가자격",
] as const;
export type DiagnoseStepName = (typeof DIAGNOSE_STEPS)[number];

export interface DiagnoseStep {
  step: DiagnoseStepName;
  ok: boolean;
  detail: string;
}

export interface Diagnosis {
  steps: DiagnoseStep[];
  /** 실제 파이프라인에서 처음으로 떨어진 단계. 끝까지 통과했으면 null (= 수집됨) */
  excludedAt: DiagnoseStepName | null;
  /**
   * 키워드·품목 단계를 통과했는지 — "우리 공고 후보였는데 다른 조건으로 빠진 것"과
   * "애초에 관련 없는 공고"를 가른다. 제외된 공고 목록에는 후보만 싣는다.
   */
  candidate: boolean;
}

export interface DiagnoseContext {
  config: AppConfig;
  mongoliaKeywords: string[];
  now: Date;
  /**
   * 면허제한정보 (본공고만). null이면 조회 실패. 사전규격은 대응 API가 없어 이 값과 무관하게
   * 판정하지 않는다.
   */
  licenseGroups: Map<string, LicenseLimitGroup[]> | null;
}

const won = (n: number): string => `${(n / 100_000_000).toFixed(2)}억`;

export function diagnoseNotice(notice: NormalizedNotice, ctx: DiagnoseContext): Diagnosis {
  const { config } = ctx;
  const isBid = notice.sourceType === "본공고";
  const steps: DiagnoseStep[] = [];

  // 마감 — 본공고만. 사전규격의 마감은 의견 등록 마감이라 지나도 의미가 있다 (deadline.ts 참고).
  if (!isBid) {
    steps.push({ step: "마감", ok: true, detail: "사전규격은 마감으로 거르지 않음" });
  } else if (isDeadlinePassed(notice.deadline, ctx.now)) {
    steps.push({ step: "마감", ok: false, detail: `이미 마감됨 (${notice.deadline})` });
  } else {
    steps.push({ step: "마감", ok: true, detail: notice.deadline ? `마감 ${notice.deadline}` : "마감일시 없음 — 통과" });
  }

  const excluded = matchExcludeKeyword(notice, config.excludeKeywords);
  steps.push(
    excluded
      ? { step: "제외키워드", ok: false, detail: `제목에 제외 키워드 '${excluded}'` }
      : { step: "제외키워드", ok: true, detail: "해당 없음" }
  );

  const budget = notice.budgetAmount;
  if (config.minBudgetAmount != null && budget != null && budget < config.minBudgetAmount) {
    steps.push({ step: "최소예산", ok: false, detail: `${won(budget)} < 기준 ${won(config.minBudgetAmount)}` });
  } else {
    steps.push({ step: "최소예산", ok: true, detail: budget == null ? "예산 정보 없음 — 통과" : won(budget) });
  }

  const category = classifyBidMethod(notice.bidMethod);
  if (category === null) {
    steps.push({ step: "낙찰방법", ok: true, detail: "낙찰방법 정보 없음 — 통과" });
  } else if (!config.allowedBidMethods.includes(category)) {
    steps.push({ step: "낙찰방법", ok: false, detail: `${category} (${notice.bidMethod}) — 허용 목록 밖` });
  } else {
    steps.push({ step: "낙찰방법", ok: true, detail: `${category} (${notice.bidMethod})` });
  }

  const overseas = detectOverseasVenue(notice.title, ctx.mongoliaKeywords);
  steps.push(
    overseas.shouldAutoExclude
      ? { step: "해외개최", ok: false, detail: "전시회·박람회 한국관/단체관 (몽골 아님) — 자동배제" }
      : { step: "해외개최", ok: true, detail: overseas.isMongolia ? `몽골 예외 (${overseas.matchedMongoliaKeyword})` : "해당 없음" }
  );

  const { matchedProductCodes, matchedIndustryCodes } = matchCodes(notice, config.productCodes, config.industryCodes);
  const matchedKeywords = matchKeywords(notice, config.keywords);
  const candidate = matchedProductCodes.length > 0 || matchedKeywords.length > 0 || overseas.isMongolia;
  const hits = [
    ...matchedProductCodes.map((c) => `품목 ${c.name}`),
    ...matchedKeywords.map((k) => `키워드 ${k}`),
    ...(overseas.isMongolia ? ["몽골 해외개최"] : []),
  ];
  const industryNote =
    matchedIndustryCodes.length > 0
      ? ` (업종 ${matchedIndustryCodes.map((c) => c.name).join(", ")}은 맞지만 업종만으로는 수집하지 않음)`
      : "";
  steps.push(
    candidate
      ? { step: "키워드·품목", ok: true, detail: hits.join(", ") }
      : {
          step: "키워드·품목",
          ok: false,
          detail:
            `제목에 등록 키워드가 없고 세부품명(${notice.productClsfcName ?? notice.productClsfcNo ?? "없음"})도 등록 품목이 아님` +
            industryNote,
        }
  );

  steps.push(qualificationStep(notice, ctx));

  const excludedAt = steps.find((s) => !s.ok)?.step ?? null;
  return { steps, excludedAt, candidate };
}

function qualificationStep(notice: NormalizedNotice, ctx: DiagnoseContext): DiagnoseStep {
  if (notice.sourceType !== "본공고") {
    return { step: "참가자격", ok: true, detail: "사전규격은 면허제한 API가 없어 판정하지 않음" };
  }
  if (ctx.licenseGroups === null || ctx.licenseGroups.size === 0) {
    return { step: "참가자격", ok: true, detail: "면허제한정보 조회 실패 — 판정 없이 통과" };
  }
  const groups = ctx.licenseGroups.get(notice.noticeNo) ?? [];
  if (groups.length === 0) return { step: "참가자격", ok: true, detail: "업종제한 없음" };

  const result = evaluateQualifications(groups, ctx.config.heldProducts, ctx.config.heldIndustries);
  if (result.passes) {
    const held = uniqueSatisfied(result.satisfiedBy).map((s) => (s.code ? `${s.name}(${s.code})` : s.name));
    return { step: "참가자격", ok: true, detail: `충족 — ${held.join(", ")}` };
  }
  // "업종명/0002" → "업종명(0002)" — 자격판정 툴팁과 같은 표기
  const label = (name: string) => name.replace(/\s*\/\s*(\d{4})\s*$/, "($1)");
  const missing = result.missingGroups.map((g) => g.allowedNames.slice(0, 4).map(label).join(" 또는 "));
  return { step: "참가자격", ok: false, detail: `미보유 — ${missing.join(" / ")}` };
}
