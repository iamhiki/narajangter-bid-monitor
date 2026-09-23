import type { NormalizedNotice } from "../api/types.js";
import type { AppConfig } from "../config/loadJsonConfig.js";
import { isNegotiatedContract } from "./bidMethod.js";
import { matchCodes } from "./codeMatcher.js";
import { matchExcludeKeyword, matchKeywords } from "./keywordMatcher.js";
import { detectOverseasVenue } from "./overseasVenueFilter.js";
import type { MatchedNotice } from "./types.js";

/**
 * 공고 하나를 코드+키워드 기준으로 평가하고 결과를 반환한다 (매칭 안 되면 null).
 *
 * 세부품명번호(물품)는 정확일치라 정밀도가 높아 단독으로도 포함시키지만,
 * 업종코드(용역/공사)는 "투찰가능업종명" 텍스트 부분일치라 정밀도가 낮다 — 무관한 공사도
 * 참가 가능 업종 중 하나로 "실내건축공사업" 등을 폭넓게 포함하는 경우가 많기 때문이다.
 * 따라서 업종코드는 제목 키워드가 함께 매칭될 때만 결과에 포함시킨다 (단독으로는 제외).
 */
/**
 * mongoliaKeywords는 호출자가 넘겨준다(기본값 빈 배열) — evaluateNotice를 순수 함수로 유지해
 * 기존 테스트가 config만 넘기던 방식을 그대로 쓸 수 있게 하기 위함. 실제 실행(index.ts)에서는
 * overseasVenueFilter.ts의 loadMongoliaKeywords()로 config/overseas-venue-keywords.json을
 * 읽어 넘긴다.
 */
export function evaluateNotice(
  notice: NormalizedNotice,
  config: AppConfig,
  mongoliaKeywords: string[] = []
): MatchedNotice | null {
  if (matchExcludeKeyword(notice, config.excludeKeywords)) return null;

  if (config.minBudgetAmount != null && notice.budgetAmount != null && notice.budgetAmount < config.minBudgetAmount) {
    return null;
  }

  // 낙찰방법이 "협상에 의한 계약"인 공고만 남긴다 — fail-open이다. bidMethod가 null이면
  // (사전규격은 이 단계에서 항상 그렇고, 본공고도 필드 인식이 빗나가면 null일 수 있음)
  // 판단할 근거가 없다는 뜻이라 거르지 않는다. "모르면 지운다"로 가면 실제 기회를 놓칠 수
  // 있어서다 — bidMethod가 값을 갖고 있는데 협상에의한이 아닌 게 확인됐을 때만 제외한다.
  if (config.requireNegotiatedContract && notice.bidMethod != null && !isNegotiatedContract(notice.bidMethod)) {
    return null;
  }

  const { matchedProductCodes, matchedIndustryCodes } = matchCodes(notice, config.productCodes, config.industryCodes);
  const matchedKeywords = matchKeywords(notice, config.keywords);

  const productCodeMatched = matchedProductCodes.length > 0;
  const industryCodeMatched = matchedIndustryCodes.length > 0;
  const keywordMatched = matchedKeywords.length > 0;

  // ③-b 해외 개최 판별: "전시회/박람회/엑스포 + 한국관/단체관"이 제목에 있으면 해외(무역박람회
  // 국가관·한국관 조성) 공고로 본다. 실제 해외 부스 시공 공고 상당수는 "박물관"/"전시관" 같은
  // 기존 국내용 키워드를 전혀 포함하지 않으므로(예: "OO 전시회 한국관 설치공사"), 이 판정은
  // 기존 코드/키워드 매칭 결과와 무관하게 독립적으로 적용한다:
  //  - 몽골이 아니면 다른 매칭 여부와 상관없이 무조건 자동배제한다.
  //  - 몽골이면, 기존 키워드/코드가 하나도 없어도 이 판정 자체를 매칭 근거로 인정한다
  //    (회사가 실제로 확장 중인 시장이라 놓치면 안 되기 때문).
  const overseasVenue = detectOverseasVenue(notice.title, mongoliaKeywords);
  if (overseasVenue.shouldAutoExclude) return null;

  const codeMatched = productCodeMatched || industryCodeMatched;

  if (!overseasVenue.isMongolia && !productCodeMatched && !keywordMatched) return null;

  return {
    notice,
    matchedProductCodes,
    matchedIndustryCodes,
    matchedKeywords,
    confidence: codeMatched && keywordMatched ? "강력추천" : "참고용",
    overseasVenueFlag: overseasVenue.isMongolia
      ? { matchedMongoliaKeyword: overseasVenue.matchedMongoliaKeyword! }
      : null,
  };
}

export function evaluateNotices(
  notices: NormalizedNotice[],
  config: AppConfig,
  mongoliaKeywords: string[] = []
): MatchedNotice[] {
  const matched: MatchedNotice[] = [];
  for (const notice of notices) {
    const result = evaluateNotice(notice, config, mongoliaKeywords);
    if (result) matched.push(result);
  }
  return matched;
}

/** 강력추천 우선, 그 다음 마감일(있으면) 빠른 순으로 정렬 */
export function sortMatches(matches: MatchedNotice[]): MatchedNotice[] {
  return [...matches].sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return a.confidence === "강력추천" ? -1 : 1;
    }
    const da = a.notice.deadline ?? "";
    const db = b.notice.deadline ?? "";
    return da.localeCompare(db);
  });
}
