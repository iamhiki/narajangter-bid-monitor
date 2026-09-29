import { describe, expect, it } from "vitest";
import { classifyBidMethod, isNegotiatedContract } from "../src/matching/bidMethod.js";

describe("classifyBidMethod", () => {
  // 원문은 2026-09-29 7일치 본공고 실측 표기
  it.each([
    ["협상에의한계약-협상에 의한 낙찰자 결정", "협상"],
    ["제한경쟁, 협상에 의한 계약", "협상"],
    ["규격가격동시입찰-제안적격자 중 예가 내 최저가 투찰자", "규격가격동시"],
    ["규격·가격 동시입찰", "규격가격동시"],
    ["적격심사제-추정가격 10억원 미만이면서 고시금액 이상", "입찰"],
    ["적격심사제-추정가격 3억원 미만 2억원 이상인 공사(전문공사)", "입찰"],
    ["최저가낙찰제", "입찰"],
    ["수의시담-수의시담", "수의"],
    ["소액수의견적-소액수의견적(2인 이상 견적 제출)-국민연금보험료 등 합산액 감액 적용", "수의"],
  ])("'%s' → %s", (bidMethod, expected) => {
    expect(classifyBidMethod(bidMethod)).toBe(expected);
  });

  it("값이 없으면 null (판단 불가)", () => {
    expect(classifyBidMethod(null)).toBeNull();
    expect(classifyBidMethod("  ")).toBeNull();
  });
});

describe("isNegotiatedContract", () => {
  it.each([
    "협상에 의한 계약",
    "협상에의한계약",
    "협상에 의한 낙찰제",
    "협상에 의한 낙찰자 결정",
    "제한경쟁, 협상에 의한 계약", // 다른 표현과 함께 나오는 경우(PoC4 R26BK01694102 실측 표기)
  ])("'%s'는 협상에의한계약으로 판별한다", (bidMethod) => {
    expect(isNegotiatedContract(bidMethod)).toBe(true);
  });

  it.each([
    "적격심사",
    "최저가낙찰제",
    "제한경쟁입찰",
    "2단계경쟁",
    // 아래 두 값은 npm run verify:api 실제 응답(sucsfbidMthdNm)에서 그대로 가져온 것(2026-09-16).
    "적격심사제-관리규정외 수기심사(총점입력)",
    "소액수의견적-소액수의견적(2인 이상 견적 제출)",
  ])("'%s'는 협상에의한계약이 아니다", (bidMethod) => {
    expect(isNegotiatedContract(bidMethod)).toBe(false);
  });

  it("bidMethod가 null이면(필드명 미확인 등) false를 반환한다 (fail-open)", () => {
    expect(isNegotiatedContract(null)).toBe(false);
  });
});
