import { describe, expect, it } from "vitest";
import { matchServiceClasses } from "../src/matching/codeMatcher.js";
import { findCoreWords } from "../src/matching/coreWork.js";
import { evaluateNotice } from "../src/matching/matchEngine.js";
import type { NormalizedNotice } from "../src/api/types.js";
import type { AppConfig } from "../src/config/loadJsonConfig.js";

// 2026-10-01 60일치 시험에서 본 공고 모양. 기관·사업명은 바꿔 적었다 — 공개 저장소
function makeNotice(title: string, overrides: Partial<NormalizedNotice> = {}): NormalizedNotice {
  return {
    noticeNo: "N-1",
    title,
    institution: "○○군",
    businessType: "용역",
    sourceType: "본공고",
    postedAt: null,
    deadline: null,
    budgetAmount: 300_000_000,
    detailUrl: null,
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: "협상에 의한 계약",
    raw: { pubPrcrmntClsfcNo: "72154099" },
    ...overrides,
  };
}

const EXHIBIT = { code: "72154099", name: "전시장치설치및디자인서비스" };
const config: AppConfig = {
  keywords: ["전시관", "조형물"],
  excludeKeywords: ["운영 용역"],
  minBudgetAmount: 100_000_000,
  businessTypes: ["물품", "용역", "공사"],
  allowedBidMethods: ["협상", "규격가격동시", "입찰"],
  productCodes: [{ code: "6012100201", name: "조형물" }],
  industryCodes: [{ code: "6815", name: "전시사업자" }],
  serviceClasses: [EXHIBIT],
  serviceClassExcludeWords: ["박람회", "부스", "한국관", "CES", "빛의 거리"],
  recipients: ["a@example.com"],
  heldProducts: [{ code: "6012100201", name: "조형물" }],
  heldIndustries: [{ code: "6815", name: "전시사업자" }],
};

describe("조달분류로 찾기 — 제목에 키워드가 없는 본업 공고", () => {
  it("전시장치설치및디자인서비스 분류면 키워드 없이도 참고용으로 수집한다", () => {
    const m = evaluateNotice(makeNotice("○○공원 야간경관 미디어 및 콘텐츠 제작·설치 용역"), config);
    expect(m?.matchedServiceClasses).toEqual([EXHIBIT]);
    expect(m?.matchedKeywords).toEqual([]);
    expect(m?.confidence).toBe("참고용");
  });

  it("박람회 부스·한국관·빛거리는 분류만으로는 걸지 않는다 (공백·대소문자 무시)", () => {
    for (const title of ["제8회 ○○산업대전 박람회 부스 설치 및 철거", "2026 ○○ 치과 전시회 한국관 전시디자인설치", "Ces 2027 ○○통합관 조성", "2026년 ○○ 빛의거리 조성 용역"]) {
      expect(matchServiceClasses(makeNotice(title), config.serviceClasses, config.serviceClassExcludeWords)).toEqual([]);
    }
  });

  it("분류가 다르거나 용역이 아니면 걸지 않는다", () => {
    expect(evaluateNotice(makeNotice("○○ 공간 조성", { raw: { pubPrcrmntClsfcNo: "80141988" } }), config)).toBeNull();
    expect(evaluateNotice(makeNotice("○○ 공간 조성", { businessType: "공사" }), config)).toBeNull();
  });

  it("제외 키워드·최소 금액은 분류로 들어와도 그대로 적용된다", () => {
    expect(evaluateNotice(makeNotice("○○ 전시체험관 운영 용역"), config)).toBeNull();
    expect(evaluateNotice(makeNotice("○○ 공간 조성", { budgetAmount: 50_000_000 }), config)).toBeNull();
  });

  it("설정에 분류가 없으면 예전과 같다", () => {
    expect(evaluateNotice(makeNotice("○○ 공간 조성"), { ...config, serviceClasses: undefined })).toBeNull();
  });
});

describe("과업 본문에서 본업 낱말 찾기", () => {
  it("등록 키워드와 전시물·체험물 같은 말을 공백 무시하고 찾는다", () => {
    expect(findCoreWords("과업 범위: 전시 물 제작 및 설치, 체험콘텐츠 개발, 미디어월 설치", ["전시관", "체험콘텐츠"])).toEqual(["체험콘텐츠", "전시물"]);
  });

  it("외식 창업 공간 디자인처럼 전시 내용이 없으면 빈 배열", () => {
    expect(findCoreWords("1. 과업개요 가. 과업명: 외식 창업 공간 및 야외광장 디자인 개발 나. 주방 설비, 간판, 파고라 설치", ["전시관", "조형물"])).toEqual([]);
  });
});
