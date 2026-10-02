import { afterEach, describe, expect, it } from "vitest";
import { buildNoticeMessage, buildSystemPrompt, isAiConfigured, judgeFit, FitJudgmentSchema } from "../src/ai/fitJudge.js";
import type { NormalizedNotice } from "../src/api/types.js";

const profile = {
  name: "주식회사 지일(JIIL)",
  headquartersRegion: null,
  coreBusiness: ["전시관 설계 및 제작·설치"],
  notOurBusiness: ["운영·유지보수 용역"],
  judgmentNotes: ["키워드가 맞아도 운영 용역이면 부적절"],
};
const held = { products: [{ code: "6012100201", name: "조형물" }], industries: [{ code: "4990", name: "실내건축공사업" }] };

const notice: NormalizedNotice = {
  noticeNo: "R26BK0001",
  title: "과학관 상설전시실 전시물 제작설치",
  institution: "국립과학관",
  businessType: "용역",
  sourceType: "본공고",
  postedAt: null,
  deadline: "2026-10-10 17:00:00",
  budgetAmount: 1_200_000_000,
  detailUrl: null,
  industryText: null,
  productClsfcNo: null,
  productClsfcName: null,
  bidMethod: "협상에의한계약",
  raw: {},
};

describe("buildSystemPrompt", () => {
  it("회사 소개·보유 자격·과거사업을 담고, 날짜 같은 가변 값이 없어 캐시가 유지된다", () => {
    const a = buildSystemPrompt(profile, held, [{ year: 2024, name: "OO과학관 전시 제작" }]);
    expect(a).toContain("전시관 설계 및 제작·설치");
    expect(a).toContain("실내건축공사업(4990)");
    expect(a).toContain("2024 OO과학관 전시 제작");
    expect(a).toContain("본점 소재지: 미확인");
    expect(buildSystemPrompt(profile, held, [{ year: 2024, name: "OO과학관 전시 제작" }])).toBe(a);
  });
});

describe("buildNoticeMessage", () => {
  it("판단에 필요한 사실을 모두 넣고, 없는 정보는 '공고에 없음'으로 쓴다", () => {
    const msg = buildNoticeMessage({
      notice: { ...notice, institution: null },
      matchReason: "키워드 과학관",
      qualificationSummary: "충족 — 실내건축공사업(4990)",
      qualDoc: {
        sourceFile: "공고문.hwpx",
        excerpt: "참가자격 가. 담당자 홍길동 010-1234-5678 로 문의",
        requirements: [{ kind: "업종", code: "4444", name: null, held: false, docName: "종합디자인분야", related: null, bases: ["면허"] }],
        region: "경상북도",
        designated: true,
        designatedCount: null,
        jiilDesignated: false,
        registrationDeadline: "2026-10-13 18:00",
        classifiedItems: [{ code: "6010989901", name: "실물모형및전시물", held: true }],
        linkedBidNo: null,
        sectionFound: true,
        performance: [{ sentence: "최근 3년 이내 단일 건으로 10억원 이상 준공실적이 있는 업체", years: 3, single: true, minAmountWon: 1e9 }],
        performanceReviewDeadline: "2026/10/06 18:00",
        submissionDeadline: null,
        sizeLimit: null,
      },
      jointBid: "(없음)공동수급불허",
      taskText: null,
      similarPast: [{ name: "OO과학관 전시", year: 2024, score: 0.41 }],
    });
    expect(msg).toContain("1,200,000,000원");
    expect(msg).toContain("발주기관: 공고에 없음");
    expect(msg).toContain("공동수급: (없음)공동수급불허");
    expect(msg).toContain("미보유 종합디자인분야(4444)");
    expect(msg).toContain("지역제한: 경상북도");
    expect(msg).toContain("명단에 지일 없음");
    expect(msg).toContain("실적 요건: 최근 3년 이내 단일 건으로 10억원 이상 준공실적이 있는 업체");
    expect(msg).toContain("실적심사신청서 마감 2026/10/06 18:00");
    expect(msg).toContain("2024 OO과학관 전시 (0.41)");
    expect(msg).toContain("과업지시서: 첨부 없음");
    // 공고문 발췌의 연락처는 외부 API로 나가기 전에 가린다
    expect(msg).not.toContain("010-1234-5678");
  });
});

describe("judgeFit 키 없음", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = saved.key;
    process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  });

  it("키가 없으면 API를 부르지 않고 이유를 돌려준다", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(isAiConfigured()).toBe(false);
    const r = await judgeFit(
      { notice, matchReason: "", qualificationSummary: null, qualDoc: null, jointBid: null, taskText: null, similarPast: [] },
      held
    );
    expect(r).toEqual({ ok: false, error: expect.stringContaining("ANTHROPIC_API_KEY") });
  });
});

describe("FitJudgmentSchema", () => {
  it("세 가지 결론만 받는다", () => {
    expect(FitJudgmentSchema.safeParse({ verdict: "적절", summary: "s", reasons: ["a"], risks: [] }).success).toBe(true);
    expect(FitJudgmentSchema.safeParse({ verdict: "좋음", summary: "s", reasons: [], risks: [] }).success).toBe(false);
  });
});
