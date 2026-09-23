import { describe, expect, it } from "vitest";
import {
  evaluateQualifications,
  extractCode,
  MAX_ALLOWED_MISSING_QUALIFICATIONS,
} from "../src/matching/qualificationFilter.js";
import type { CodeEntry } from "../src/config/loadJsonConfig.js";

const held: { products: CodeEntry[]; industries: CodeEntry[] } = {
  products: [{ code: "6010989901", name: "실물모형및전시물" }],
  industries: [
    { code: "0006", name: "실내건축공사업" },
    { code: "0036", name: "정보통신공사업" },
    { code: "1440", name: "금속구조물·창호·온실공사업" },
  ],
};
const check = (allowedNames: string[]) =>
  evaluateQualifications([{ groupNo: "1", allowedNames }], held.products, held.industries);

describe("extractCode", () => {
  it("업종명/코드 형태에서 코드를 뗀다", () => {
    expect(extractCode("정보통신공사업/0036")).toBe("0036");
    expect(extractCode(" 건축공사업 / 0002 ")).toBe("0002");
  });
  it("코드가 없으면 null", () => {
    expect(extractCode("축산물가공업(식육가공업)")).toBeNull();
    expect(extractCode("업종명/12")).toBeNull(); // 4자리가 아니면 코드로 안 본다
  });
});

describe("코드 대조 (이름 부분일치 금지)", () => {
  it("건축공사업(0002)을 실내건축공사업(0006)으로 충족하지 않는다", () => {
    // 이전 구현은 "실내건축공사업".includes("건축공사업")이 참이라 충족으로 봤다.
    // 그 탓에 건축공사업 제한이 걸린 710억 건물 신축공사가 통과했다.
    expect(check(["건축공사업/0002"]).passes).toBe(false);
  });

  it("조경식재·시설물공사업(4993)도 충족하지 않는다", () => {
    expect(check(["조경식재·시설물공사업/4993"]).passes).toBe(false);
  });

  it("보유한 코드면 통과한다", () => {
    expect(check(["실내건축공사업/0006"]).passes).toBe(true);
    expect(check(["정보통신공사업/0036"]).passes).toBe(true);
  });

  it("그룹 안 허용업종은 OR — 하나만 보유하면 된다", () => {
    expect(check(["건축공사업/0002", "실내건축공사업/0006"]).passes).toBe(true);
  });
});

describe("부족 허용치 0", () => {
  it("그룹 1개짜리도 못 채우면 제외한다", () => {
    // 이전 값 1은 면허제한 공고의 72%(그룹 1개짜리)에 대해 필터를 무력화했다.
    expect(MAX_ALLOWED_MISSING_QUALIFICATIONS).toBe(0);
    const r = check(["식품판매업(기타 식품판매업)/5212"]);
    expect(r.missingCount).toBe(1);
    expect(r.passes).toBe(false);
  });

  it("그룹은 AND — 하나라도 못 채우면 제외", () => {
    const r = evaluateQualifications(
      [
        { groupNo: "1", allowedNames: ["실내건축공사업/0006"] },
        { groupNo: "2", allowedNames: ["건축공사업/0002"] },
      ],
      held.products,
      held.industries
    );
    expect(r.missingCount).toBe(1);
    expect(r.passes).toBe(false);
  });
});

describe("코드가 없는 그룹", () => {
  it("이름 완전일치로만 본다 (부분일치 아님)", () => {
    expect(check(["실내건축공사업"]).passes).toBe(true);
    expect(check(["건축공사업"]).passes).toBe(false); // 부분일치라면 통과했을 값
    expect(check(["실내건축공사업"]).nameFallbackGroups).toBe(1);
  });
});

describe("fail-open", () => {
  it("자격 정보가 없으면 통과시킨다", () => {
    const r = evaluateQualifications([], held.products, held.industries);
    expect(r.passes).toBe(true);
    expect(r.totalGroups).toBe(0);
  });
});
