import { describe, expect, it } from "vitest";
import { diagnoseNotice, type DiagnoseContext } from "../src/matching/diagnose.js";
import { evaluateNotice } from "../src/matching/matchEngine.js";
import type { NormalizedNotice } from "../src/api/types.js";
import type { AppConfig } from "../src/config/loadJsonConfig.js";

function makeNotice(overrides: Partial<NormalizedNotice> = {}): NormalizedNotice {
  return {
    noticeNo: "N-1",
    title: "과학관 전시물 제작설치",
    institution: "테스트 기관",
    businessType: "용역",
    sourceType: "본공고",
    postedAt: "20260920",
    deadline: "2026-10-10 17:00:00",
    budgetAmount: 500_000_000,
    detailUrl: null,
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: "협상에의한계약-협상에 의한 낙찰자 결정",
    raw: {},
    ...overrides,
  };
}

const config: AppConfig = {
  keywords: ["과학관", "놀이시설"],
  excludeKeywords: ["건축", "구매"],
  minBudgetAmount: 100_000_000,
  businessTypes: ["물품", "용역", "공사"],
  allowedBidMethods: ["협상", "규격가격동시", "입찰"],
  productCodes: [{ code: "4924159701", name: "조합놀이대" }],
  industryCodes: [{ code: "6815", name: "전시사업자" }],
  recipients: ["a@example.com"],
  heldProducts: [],
  heldIndustries: [{ code: "0006", name: "실내건축공사업" }],
};

const ctx: DiagnoseContext = {
  config,
  mongoliaKeywords: ["몽골"],
  now: new Date("2026-09-29T09:00:00+09:00"),
  licenseGroups: new Map([
    ["N-OK", [{ groupNo: "1", allowedNames: ["실내건축공사업/0006"] }]],
    ["N-NO", [{ groupNo: "1", allowedNames: ["건축공사업/0002"] }]],
  ]),
};

describe("diagnoseNotice", () => {
  it("모든 조건을 통과하면 수집됨", () => {
    const d = diagnoseNotice(makeNotice(), ctx);
    expect(d.excludedAt).toBeNull();
    expect(d.candidate).toBe(true);
  });

  it("처음 떨어진 단계를 excludedAt으로, 그 뒤 단계도 끝까지 판정한다", () => {
    const d = diagnoseNotice(makeNotice({ title: "과학관 건축 공사", budgetAmount: 50_000_000 }), ctx);
    expect(d.excludedAt).toBe("제외키워드");
    expect(d.steps.find((s) => s.step === "최소예산")?.ok).toBe(false); // 둘 다 보여야 한다
    expect(d.candidate).toBe(true);
  });

  it("수의계약은 낙찰방법에서 빠진다", () => {
    expect(diagnoseNotice(makeNotice({ bidMethod: "수의시담-수의시담" }), ctx).excludedAt).toBe("낙찰방법");
  });

  it("키워드·품목이 없으면 후보가 아니다", () => {
    const d = diagnoseNotice(makeNotice({ title: "청사 승강기 교체" }), ctx);
    expect(d.excludedAt).toBe("키워드·품목");
    expect(d.candidate).toBe(false);
  });

  it("참가자격 미보유는 빼지 않고 표시만 한다 (공동수급으로 참가할 수 있어서)", () => {
    const no = diagnoseNotice(makeNotice({ noticeNo: "N-NO" }), ctx);
    expect(no.excludedAt).toBeNull();
    expect(no.steps.at(-1)?.detail).toContain("자격 미보유");
    expect(no.steps.at(-1)?.detail).toContain("건축공사업(0002)");
    const ok = diagnoseNotice(makeNotice({ noticeNo: "N-OK" }), ctx);
    expect(ok.excludedAt).toBeNull();
    expect(ok.steps.at(-1)?.detail).toContain("실내건축공사업(0006)");
  });

  it("품목과 제목 키워드를 출처별로 나눠 적는다 — 같은 말이 두 번 나와도 어디서 걸렸는지 보이게", () => {
    const d = diagnoseNotice(makeNotice({ title: "과학관 조합놀이대 설치", businessType: "물품", productClsfcNo: "4924159701", productClsfcName: "조합놀이대" }), ctx);
    expect(d.steps.find((s) => s.step === "키워드·품목")?.detail).toBe(
      "[나라장터 물품분류] '조합놀이대' — 우리 등록 품목 · [공고 제목] '과학관' — 우리 키워드"
    );
  });

  it("제목엔 없고 세부품명 이름에만 있는 키워드는 [세부품명 이름]으로 적는다 (신평초 '…디자인 구조물')", () => {
    const d = diagnoseNotice(
      makeNotice({ title: "보행환경안심길 조성공사-디자인 구조물", businessType: "물품", productClsfcNo: "4924159701", productClsfcName: "조합놀이대 과학관" }),
      ctx
    );
    expect(d.steps.find((s) => s.step === "키워드·품목")?.detail).toBe(
      "[나라장터 물품분류] '조합놀이대' — 우리 등록 품목 · [세부품명 이름] '과학관' — 우리 키워드"
    );
  });

  it("마감 지난 본공고는 마감에서 빠지지만, 사전규격은 거르지 않는다", () => {
    expect(diagnoseNotice(makeNotice({ deadline: "2026-09-28 10:00:00" }), ctx).excludedAt).toBe("마감");
    expect(
      diagnoseNotice(makeNotice({ deadline: "2026-09-28 10:00:00", sourceType: "사전규격", bidMethod: null }), ctx).excludedAt
    ).toBeNull();
  });
});

describe("diagnoseNotice는 matchEngine.evaluateNotice와 판정이 같다", () => {
  // 마감·참가자격은 evaluateNotice 바깥(pipeline)에서 거르므로 그 두 단계를 뺀 결과를 비교한다.
  const engineSteps = new Set(["제외키워드", "최소예산", "낙찰방법", "해외개최", "키워드·품목"]);
  const cases: Partial<NormalizedNotice>[] = [
    {},
    { title: "과학관 건축공사" },
    { budgetAmount: 10_000_000 },
    { budgetAmount: null },
    { bidMethod: "소액수의견적-소액수의견적" },
    { bidMethod: "적격심사제-추정가격 10억원 이상" },
    { bidMethod: null },
    { title: "2027 두바이 박람회 한국관 과학관 조성" },
    { title: "2027 몽골 박람회 한국관 조성" },
    { title: "청사 승강기 교체" },
    { title: "놀이터 조성", businessType: "물품", productClsfcNo: "4924159701" },
  ];

  it.each(cases.map((c, i) => [i, c] as const))("사례 %i", (_i, overrides) => {
    const notice = makeNotice(overrides);
    const d = diagnoseNotice(notice, ctx);
    const failedInEngine = d.steps.some((s) => engineSteps.has(s.step) && !s.ok);
    expect(failedInEngine).toBe(evaluateNotice(notice, config, ctx.mongoliaKeywords) === null);
  });
});
