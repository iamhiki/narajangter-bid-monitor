import { describe, expect, it } from "vitest";
import { matchCodes } from "../src/matching/codeMatcher.js";
import { matchKeywords } from "../src/matching/keywordMatcher.js";
import { evaluateNotice, evaluateNotices, sortMatches } from "../src/matching/matchEngine.js";
import type { NormalizedNotice } from "../src/api/types.js";
import type { AppConfig } from "../src/config/loadJsonConfig.js";

function makeNotice(overrides: Partial<NormalizedNotice> = {}): NormalizedNotice {
  return {
    noticeNo: "N-1",
    title: "테스트 공고",
    institution: "테스트 기관",
    businessType: "물품",
    sourceType: "본공고",
    postedAt: "20260701",
    deadline: "20260710",
    budgetAmount: 10_000_000,
    detailUrl: "https://example.com",
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: null,
    raw: {},
    ...overrides,
  };
}

const config: AppConfig = {
  keywords: ["도서관", "전시"],
  excludeKeywords: ["구입", "정비"],
  minBudgetAmount: null,
  businessTypes: ["물품", "용역", "공사"],
  requireNegotiatedContract: false,
  productCodes: [{ code: "5512190301", name: "안내전광판" }],
  industryCodes: [{ code: "6815", name: "전시사업자" }],
  recipients: ["a@example.com"],
  heldProducts: [{ code: "5512190301", name: "안내전광판" }],
  heldIndustries: [{ code: "6815", name: "전시사업자" }],
};

describe("matchCodes", () => {
  it("물품 공고는 세부품명번호 정확일치로 매칭된다", () => {
    const notice = makeNotice({ businessType: "물품", productClsfcNo: "5512190301" });
    const result = matchCodes(notice, config.productCodes, config.industryCodes);
    expect(result.matchedProductCodes).toHaveLength(1);
    expect(result.matchedProductCodes[0]?.code).toBe("5512190301");
  });

  it("물품 공고라도 코드가 다르면 매칭되지 않는다", () => {
    const notice = makeNotice({ businessType: "물품", productClsfcNo: "0000000000" });
    const result = matchCodes(notice, config.productCodes, config.industryCodes);
    expect(result.matchedProductCodes).toHaveLength(0);
  });

  it("용역/공사 공고는 투찰가능업종명 텍스트 부분일치로 매칭된다", () => {
    const notice = makeNotice({ businessType: "용역", industryText: "전시사업자, 이벤트업" });
    const result = matchCodes(notice, config.productCodes, config.industryCodes);
    expect(result.matchedIndustryCodes).toHaveLength(1);
    expect(result.matchedIndustryCodes[0]?.name).toBe("전시사업자");
  });

  it("industryText가 없으면 매칭되지 않는다", () => {
    const notice = makeNotice({ businessType: "공사", industryText: null });
    const result = matchCodes(notice, config.productCodes, config.industryCodes);
    expect(result.matchedIndustryCodes).toHaveLength(0);
  });
});

describe("matchKeywords", () => {
  it("제목에 키워드가 포함되면 매칭된다", () => {
    const notice = makeNotice({ title: "국립과학 도서관 리모델링 공사" });
    expect(matchKeywords(notice, config.keywords)).toEqual(["도서관"]);
  });

  it("여러 키워드가 매칭되면 모두 반환한다", () => {
    const notice = makeNotice({ title: "도서관 전시 공간 조성" });
    expect(matchKeywords(notice, config.keywords)).toEqual(["도서관", "전시"]);
  });

  it("키워드가 없으면 빈 배열을 반환한다", () => {
    const notice = makeNotice({ title: "도로 포장 공사" });
    expect(matchKeywords(notice, config.keywords)).toEqual([]);
  });

  it("제목과 키워드의 공백 유무가 달라도 매칭된다", () => {
    const notice = makeNotice({ title: "도서관운영 용역" });
    expect(matchKeywords(notice, ["도서관 운영"])).toEqual(["도서관 운영"]);
  });
});

describe("제외 키워드", () => {
  it("코드+키워드가 모두 매칭돼도 제외 키워드가 제목에 있으면 null이다", () => {
    const notice = makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "전시 안내전광판 구입",
    });
    expect(evaluateNotice(notice, config)).toBeNull();
  });

  it("업종코드로 매칭돼도 제외 키워드(정비)가 있으면 null이다", () => {
    const notice = makeNotice({
      businessType: "공사",
      industryText: "전시사업자",
      title: "전시관 정비 공사",
    });
    expect(evaluateNotice(notice, config)).toBeNull();
  });

  it("제외 키워드가 없으면 평소대로 매칭된다", () => {
    const notice = makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "전시 안내전광판 설치",
    });
    expect(evaluateNotice(notice, config)).not.toBeNull();
  });
});

describe("업종코드 단독 매칭", () => {
  it("업종코드만 매칭되고 키워드가 없으면 null이다 (업종코드는 정밀도가 낮아 단독 불충분)", () => {
    const notice = makeNotice({
      businessType: "공사",
      industryText: "전시사업자, 종합건설업",
      title: "고속도로 방음벽 개량공사",
    });
    expect(evaluateNotice(notice, config)).toBeNull();
  });

  it("업종코드 + 키워드가 함께 매칭되면 강력추천이다", () => {
    const notice = makeNotice({
      businessType: "공사",
      industryText: "전시사업자, 종합건설업",
      title: "전시 공간 조성 공사",
    });
    const result = evaluateNotice(notice, config);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe("강력추천");
  });
});

describe("최소 예산금액 필터", () => {
  const budgetConfig: AppConfig = { ...config, minBudgetAmount: 100_000_000 };

  it("예산금액이 기준보다 작으면 코드/키워드가 매칭돼도 null이다", () => {
    const notice = makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "전시 안내전광판 설치",
      budgetAmount: 50_000_000,
    });
    expect(evaluateNotice(notice, budgetConfig)).toBeNull();
  });

  it("예산금액이 기준 이상이면 매칭된다", () => {
    const notice = makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "전시 안내전광판 설치",
      budgetAmount: 150_000_000,
    });
    expect(evaluateNotice(notice, budgetConfig)).not.toBeNull();
  });

  it("예산금액이 없으면(null) 판단할 수 없으므로 제외하지 않는다", () => {
    const notice = makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "전시 안내전광판 설치",
      budgetAmount: null,
    });
    expect(evaluateNotice(notice, budgetConfig)).not.toBeNull();
  });

  it("minBudgetAmount가 null이면 예산과 무관하게 매칭된다", () => {
    const notice = makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "전시 안내전광판 설치",
      budgetAmount: 1,
    });
    expect(evaluateNotice(notice, config)).not.toBeNull();
  });
});

describe("낙찰방법 필터 (requireNegotiatedContract)", () => {
  const negotiatedConfig: AppConfig = { ...config, requireNegotiatedContract: true };

  function negotiatedNotice(overrides: Partial<NormalizedNotice> = {}): NormalizedNotice {
    return makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "전시 안내전광판 설치",
      ...overrides,
    });
  }

  it("낙찰방법이 '협상에 의한 계약'이면 매칭된다", () => {
    const notice = negotiatedNotice({ bidMethod: "협상에 의한 계약" });
    expect(evaluateNotice(notice, negotiatedConfig)).not.toBeNull();
  });

  it("뒤에 붙는 말이 달라도(예: 협상에 의한 낙찰자 결정) 매칭된다", () => {
    const notice = negotiatedNotice({ bidMethod: "협상에의한계약-협상에 의한 낙찰자 결정" });
    expect(evaluateNotice(notice, negotiatedConfig)).not.toBeNull();
  });

  it("낙찰방법이 협상에 의한 계약이 아니면 코드/키워드가 맞아도 제외된다", () => {
    const notice = negotiatedNotice({ bidMethod: "적격심사제-관리규정외 수기심사(총점입력)" });
    expect(evaluateNotice(notice, negotiatedConfig)).toBeNull();
  });

  it("낙찰방법을 아직 모르면(null) fail-open으로 거르지 않는다 — 사전규격이 이 경우다", () => {
    const notice = negotiatedNotice({ bidMethod: null });
    expect(evaluateNotice(notice, negotiatedConfig)).not.toBeNull();
  });

  it("옵션이 꺼져 있으면(기본값) 낙찰방법과 무관하게 매칭된다", () => {
    const notice = negotiatedNotice({ bidMethod: "적격심사제-관리규정외 수기심사(총점입력)" });
    expect(evaluateNotice(notice, config)).not.toBeNull();
  });
});

describe("evaluateNotice / confidence", () => {
  it("코드+키워드 모두 매칭되면 강력추천이다", () => {
    const notice = makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "전시 안내전광판 설치",
    });
    const result = evaluateNotice(notice, config);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe("강력추천");
  });

  it("코드만 매칭되면 참고용이다", () => {
    const notice = makeNotice({
      businessType: "물품",
      productClsfcNo: "5512190301",
      title: "안내표시장치 구매",
    });
    const result = evaluateNotice(notice, config);
    expect(result?.confidence).toBe("참고용");
  });

  it("키워드만 매칭되면 참고용이다", () => {
    const notice = makeNotice({ businessType: "물품", productClsfcNo: null, title: "도서관 리모델링" });
    const result = evaluateNotice(notice, config);
    expect(result?.confidence).toBe("참고용");
  });

  it("아무것도 매칭되지 않으면 null이다", () => {
    const notice = makeNotice({ businessType: "물품", productClsfcNo: null, title: "도로 포장 공사" });
    expect(evaluateNotice(notice, config)).toBeNull();
  });

  it("evaluateNotices는 매칭된 공고만 필터링한다", () => {
    const notices = [
      makeNotice({ title: "도서관 신축", noticeNo: "A" }),
      makeNotice({ title: "도로 공사", noticeNo: "B" }),
    ];
    const result = evaluateNotices(notices, config);
    expect(result).toHaveLength(1);
    expect(result[0]?.notice.noticeNo).toBe("A");
  });
});

describe("evaluateNotice / 해외 개최 판별(③-b) 통합", () => {
  it("전시회+한국관 매칭 & 몽골 키워드 없으면 자동배제(null)된다", () => {
    const notice = makeNotice({
      title: "2026 독일 프랑크푸르트 소비재 전시회 한국관 전시관 설치공사",
      businessType: "물품",
      productClsfcNo: null,
    });
    // "전시관" 키워드가 있어 기존 로직상으로는 매칭 대상이었을 것이나, 해외 개최 자동배제가 우선한다.
    expect(evaluateNotice(notice, config, [])).toBeNull();
  });

  it("전시회+한국관 매칭 & 몽골 키워드가 있으면 배제하지 않고 플래그만 남긴다", () => {
    const notice = makeNotice({
      title: "2026 몽골 울란바토르 전시회 한국관 전시관 설치공사",
      businessType: "물품",
      productClsfcNo: null,
    });
    const result = evaluateNotice(notice, config, ["몽골", "울란바토르"]);
    expect(result).not.toBeNull();
    expect(result?.overseasVenueFlag).toEqual({ matchedMongoliaKeyword: "몽골" });
  });

  it("기존 국내 키워드가 하나도 없어도, 몽골 관련 해외 개최면 그 자체로 매칭된다 (독립 트리거)", () => {
    // 실제 해외 부스 시공 공고 상당수는 "박물관"/"전시관" 같은 기존 키워드를 전혀 포함하지 않는다
    // (예: "2026 몽골 국제박람회 한국관 설치공사"). 이 경우도 몽골이면 놓치지 않아야 한다.
    const notice = makeNotice({
      title: "2026 몽골 국제박람회 한국관 설치공사",
      businessType: "용역",
      productClsfcNo: null,
      industryText: null,
    });
    expect(matchKeywords(notice, config.keywords)).toEqual([]); // 국내 키워드는 정말 없음(전제 확인)
    const result = evaluateNotice(notice, config, ["몽골"]);
    expect(result).not.toBeNull();
    expect(result?.overseasVenueFlag).toEqual({ matchedMongoliaKeyword: "몽골" });
    expect(result?.confidence).toBe("참고용");
  });

  it("기존 국내 키워드가 없고 몽골도 아닌 해외 개최는 원래도 null이었고 지금도 null이다", () => {
    const notice = makeNotice({
      title: "2026 독일 프랑크푸르트 소비재 전시회 한국관 설치공사",
      businessType: "용역",
      productClsfcNo: null,
      industryText: null,
    });
    expect(evaluateNotice(notice, config, [])).toBeNull();
  });

  it("해외 개최 키워드가 없는 일반 공고는 overseasVenueFlag가 null이다", () => {
    const notice = makeNotice({ title: "도서관 리모델링", businessType: "물품", productClsfcNo: null });
    const result = evaluateNotice(notice, config, ["몽골"]);
    expect(result?.overseasVenueFlag).toBeNull();
  });

  it("mongoliaKeywords를 넘기지 않으면(기본값 []) 해외 개최 매칭 시 항상 자동배제된다", () => {
    const notice = makeNotice({ title: "2026 몽골 전시회 한국관 전시관 설치공사", businessType: "물품" });
    expect(evaluateNotice(notice, config)).toBeNull();
  });
});

describe("sortMatches", () => {
  it("강력추천을 참고용보다 앞에 정렬한다", () => {
    const weak = evaluateNotice(makeNotice({ title: "도서관", noticeNo: "weak" }), config)!;
    const strong = evaluateNotice(
      makeNotice({ title: "도서관 전시 안내전광판", productClsfcNo: "5512190301", noticeNo: "strong" }),
      config
    )!;
    const sorted = sortMatches([weak, strong]);
    expect(sorted[0]?.notice.noticeNo).toBe("strong");
  });
});
