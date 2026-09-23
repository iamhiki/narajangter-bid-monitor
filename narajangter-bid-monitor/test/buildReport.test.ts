import { describe, expect, it } from "vitest";
import { buildReport, type ReportInput } from "../src/report/buildReport.js";
import type { MatchedNotice } from "../src/matching/types.js";
import type { NormalizedNotice } from "../src/api/types.js";

/**
 * 공동수급 표시(renderJointBidHtml/Text)에 대한 최소 회귀 테스트.
 * buildReport.ts 전체를 다루는 기존 테스트가 없어, 이번에 건드린 부분만 좁게 검증한다.
 */

function makeNotice(overrides: Partial<NormalizedNotice> = {}): NormalizedNotice {
  return {
    noticeNo: "R26BK01695832",
    title: "정선군 복합문화센터 공간디자인 및 전시물 제작 설치",
    institution: "정선군",
    businessType: "용역",
    sourceType: "본공고",
    postedAt: null,
    deadline: "2026-10-01",
    budgetAmount: 350000000,
    detailUrl: null,
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: null,
    raw: {},
    ...overrides,
  };
}

function makeMatch(overrides: Partial<MatchedNotice> = {}): MatchedNotice {
  return {
    notice: makeNotice(),
    matchedProductCodes: [],
    matchedIndustryCodes: [],
    matchedKeywords: ["전시"],
    confidence: "강력추천",
    overseasVenueFlag: null,
    ...overrides,
  };
}

function makeInput(match: MatchedNotice): ReportInput {
  const now = new Date("2026-09-23T09:00:00+09:00");
  return {
    generatedAt: now,
    window: { begin: new Date("2026-09-16T00:00:00+09:00"), end: now },
    bid: { matches: [match], failures: [] },
    preStandard: { matches: [], failures: [] },
  };
}

describe("buildReport — 공동수급 표시", () => {
  it("값이 있으면 HTML·텍스트 본문에 그대로 적는다", () => {
    const { html, text } = buildReport(makeInput(makeMatch({ jointBidStatus: "(없음)공동수급불허" })));
    expect(html).toContain("공동수급: (없음)공동수급불허");
    expect(text).toContain("공동수급: (없음)공동수급불허");
  });

  it("조회를 안 했거나 실패해 필드가 없으면 아무것도 적지 않는다", () => {
    const { html, text } = buildReport(makeInput(makeMatch()));
    expect(html).not.toContain("공동수급");
    expect(text).not.toContain("공동수급");
  });
});
