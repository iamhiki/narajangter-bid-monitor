import type { NormalizedNotice } from "../api/types.js";
import type { LicenseLimitGroup } from "../api/licenseLimitApi.js";
import type { AppConfig } from "../config/loadJsonConfig.js";
import { classifyBidMethod } from "./bidMethod.js";
import { hasStandaloneProductMatch, matchCodes, matchServiceClasses } from "./codeMatcher.js";
import { isDeadlinePassed } from "./deadline.js";
import { matchExcludeKeyword, matchKeywords } from "./keywordMatcher.js";
import { detectOverseasVenue } from "./overseasVenueFilter.js";
import { linkedBidNoticeNo } from "./matchEngine.js";
import { evaluateQualifications, missingLabels, uniqueSatisfied } from "./qualificationFilter.js";

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
  "본공고 게시",
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

  const linked = linkedBidNoticeNo(notice);
  steps.push(
    linked
      ? { step: "본공고 게시", ok: false, detail: `본공고가 이미 게시됨 (${linked}) — 본공고로 확인` }
      : { step: "본공고 게시", ok: true, detail: isBid ? "본공고" : "아직 본공고 없음" }
  );

  const excluded = matchExcludeKeyword(notice, config.excludeKeywords, config);
  steps.push(
    excluded
      ? { step: "제외키워드", ok: false, detail: `제목에 제외 키워드 '${excluded}'` }
      : { step: "제외키워드", ok: true, detail: "해당 없음" }
  );

  const budget = notice.budgetAmount;
  if (config.minBudgetAmount != null && budget != null && budget < config.minBudgetAmount) {
    steps.push({ step: "최소예산", ok: false, detail: `추정가격 ${won(budget)} < 기준 ${won(config.minBudgetAmount)}` });
  } else {
    steps.push({ step: "최소예산", ok: true, detail: budget == null ? "금액 정보 없음 — 통과" : `추정가격 ${won(budget)}` });
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
  const matchedServiceClasses = matchServiceClasses(notice, config.serviceClasses, config.serviceClassExcludeWords);
  const candidate =
    hasStandaloneProductMatch(matchedProductCodes) || matchedKeywords.length > 0 || overseas.isMongolia || matchedServiceClasses.length > 0;
  // 어디서 걸렸는지를 말로 구분한다 — "품목 조형물, 키워드 조형물"처럼 쓰면 같은 말이 두 번 나와
  // 무엇이 다른지 알 수 없었다 (2026-10-02 요청). 품목 = 발주기관이 나라장터에 등록한 물품 분류,
  // 키워드 = 공고 제목에 든 말.
  const quoted = (xs: string[]) => xs.map((x) => `'${x}'`).join(", ");
  const bare = (s: string) => s.replace(/\s+/g, "");
  const inTitle = matchedKeywords.filter((k) => bare(notice.title).includes(bare(k)));
  const inNameOnly = matchedKeywords.filter((k) => !inTitle.includes(k));
  const hits = [
    matchedProductCodes.length ? `[나라장터 물품분류] ${quoted(matchedProductCodes.map((c) => c.name))} — 우리 등록 품목` : null,
    matchedServiceClasses.length ? `[나라장터 용역분류] ${quoted(matchedServiceClasses.map((c) => c.name))} — 우리 등록 분야` : null,
    // 키워드는 제목 + 세부품명 이름에서 찾는다(keywordMatcher) — 제목에 없고 품명 이름에만 있으면 그렇게 적는다
    // (신평초 보행환경안심길 "…디자인 구조물": 제목엔 '조형물'이 없고 세부품명이 '조형물'이었다)
    inTitle.length ? `[공고 제목] ${quoted(inTitle)} — 우리 키워드` : null,
    inNameOnly.length ? `[세부품명 이름] ${quoted(inNameOnly)} — 우리 키워드` : null,
    overseas.isMongolia ? "몽골 해외개최" : null,
  ].filter((x): x is string => x !== null);
  const industryNote =
    matchedIndustryCodes.length > 0
      ? ` (업종 ${matchedIndustryCodes.map((c) => c.name).join(", ")}은 맞지만 업종만으로는 수집하지 않음)`
      : "";
  const keywordOnlyProducts = matchedProductCodes.filter((c) => c.requiresKeyword);
  const productNote =
    keywordOnlyProducts.length > 0
      ? `제목에 등록 키워드가 없음 — 세부품명(${keywordOnlyProducts.map((c) => c.name).join(", ")})이 등록 품목이긴 하지만 ` +
        `쓰임새가 넓어 키워드가 같이 있을 때만 수집함`
      : `제목에 등록 키워드가 없고 세부품명(${notice.productClsfcName ?? notice.productClsfcNo ?? "없음"})도 등록 품목이 아님`;
  steps.push(
    candidate
      ? { step: "키워드·품목", ok: true, detail: hits.join(" · ") }
      : {
          step: "키워드·품목",
          ok: false,
          detail: productNote + industryNote,
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
  // 미보유여도 빼지 않는다 — 공동수급이 허용되면 함께 참가할 수 있어 표시만 한다 (applyQualificationFilter와 같은 판단)
  const missing = missingLabels(result.missingGroups).map((g) => g.text);
  return { step: "참가자격", ok: true, detail: `자격 미보유(공동수급 확인 필요) — 아래 중 하나 필요: ${missing.join(" / 또는 ")}` };
}
