import { describe, expect, it } from "vitest";
import {
  evaluateQualifications,
  extractCode,
  missingLabels,
  uniqueSatisfied,
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

describe("미충족 판정", () => {
  it("그룹 1개짜리도 못 채우면 미충족이다", () => {
    const r = check(["식품판매업(기타 식품판매업)/5212"]);
    expect(r.missingCount).toBe(1);
    expect(r.passes).toBe(false);
  });

  it("미충족 그룹은 화면 표기(업종명(코드))로 뽑는다", () => {
    const r = check(["건축공사업/0002", "토목건축공사업/0001"]);
    expect(missingLabels(r.missingGroups)).toEqual([
      { groupNo: "1", names: ["건축공사업(0002)", "토목건축공사업(0001)"], text: "건축공사업(0002) 또는 토목건축공사업(0001)" },
    ]);
  });

  it("그룹끼리는 '또는' — 하나만 채우면 충족 (나라장터: '[건축공사업] 업종 또는 [토목건축공사업] 업종')", () => {
    const r = evaluateQualifications(
      [
        { groupNo: "1", allowedNames: ["실내건축공사업/0006"] },
        { groupNo: "2", allowedNames: ["건축공사업/0002"] },
      ],
      held.products,
      held.industries
    );
    expect(r.passes).toBe(true);
    expect(r.missingCount).toBe(0);
  });

  it("그룹을 하나도 못 채우면 모든 그룹이 '이 중 하나 필요'로 나온다", () => {
    const g = (groupNo: string, rows: string[][]) => ({ groupNo, allowedNames: rows.flat(), rows });
    const r = evaluateQualifications(
      [g("1", [["건축공사업/0002", "토목건축공사업/0003"]]), g("2", [["토목건축공사업/0003"]])],
      held.products,
      held.industries
    );
    expect(r.passes).toBe(false);
    expect(r.missingGroups.map((x) => x.groupNo)).toEqual(["1", "2"]);
    // 그룹2(토목건축공사업)는 그룹1 선택지에 이미 들어 있어 표시에서는 한 줄로 (백령 점박이물범 체험관)
    expect(missingLabels(r.missingGroups).map((x) => x.text)).toEqual(["건축공사업(0002) 또는 토목건축공사업(0003)"]);
  });

  it("그룹 안의 순번은 '그리고' — 순번을 모두 채워야 그 그룹이 충족 (가양4단지 공고문: '…과 …을 모두 등록한 자')", () => {
    const g = (groupNo: string, rows: string[][]) => ({ groupNo, allowedNames: rows.flat(), rows });
    const groups = [g("1", [["토목공사업/0001", "토목건축공사업/0003"]]), g("2", [["지반조성ㆍ포장공사업/4989"], ["상ㆍ하수도설비공사업/4996"]])];
    const one = evaluateQualifications(groups, [], [{ code: "4989", name: "지반조성ㆍ포장공사업" }]);
    expect(one.passes).toBe(false);
    expect(missingLabels(one.missingGroups).map((x) => x.text)).toEqual([
      "토목공사업(0001) 또는 토목건축공사업(0003)",
      "지반조성ㆍ포장공사업(4989) + 상ㆍ하수도설비공사업(4996)",
    ]);
    const both = evaluateQualifications(groups, [], [
      { code: "4989", name: "지반조성ㆍ포장공사업" },
      { code: "4996", name: "상ㆍ하수도설비공사업" },
    ]);
    expect(both.passes).toBe(true);
  });

  it("순번의 허용업종(대체 업종)도 인정한다", () => {
    const r = evaluateQualifications(
      [{ groupNo: "1", allowedNames: [], rows: [["건축공사업/0002", "토목건축공사업/0003"]] }],
      [],
      [{ code: "0003", name: "토목건축공사업" }]
    );
    expect(r.passes).toBe(true);
  });
});

describe("코드가 없는 그룹", () => {
  it("이름 완전일치로만 본다 (부분일치 아님)", () => {
    expect(check(["실내건축공사업"]).passes).toBe(true);
    expect(check(["건축공사업"]).passes).toBe(false); // 부분일치라면 통과했을 값
    expect(check(["실내건축공사업"]).nameFallbackGroups).toBe(1);
  });
});

describe("satisfiedBy (화면 표시용)", () => {
  it("그룹마다 채운 보유 자격을 보유 목록의 이름과 코드로 남긴다", () => {
    const r = evaluateQualifications(
      [
        { groupNo: "1", allowedNames: ["건축공사업/0002", "실내 건축공사업/0006"] },
        { groupNo: "2", allowedNames: ["정보통신공사업"] },
      ],
      held.products,
      held.industries
    );
    expect(r.satisfiedBy).toEqual([
      { groupNo: "1", name: "실내건축공사업", code: "0006" },
      // 코드 없는 그룹은 이름으로만 맞췄으므로 코드를 추측해 붙이지 않는다
      { groupNo: "2", name: "정보통신공사업", code: null },
    ]);
  });

  it("여러 그룹에 공통인 자격은 uniqueSatisfied에서 한 번만, 채운 그룹 수와 함께 나온다", () => {
    // 2026-09-29 울진해양과학관 공고: 4개 그룹 모두에 1469·4990이 들어 있다
    const groups = ["4440", "4442", "4443", "4444"].map((c, i) => ({
      groupNo: String(i + 1),
      allowedNames: ["소프트웨어사업자(디지털콘텐츠개발서비스사업)/1469", "실내건축공사업/0006", `산업디자인/${c}`],
    }));
    const r = evaluateQualifications(groups, [], [
      { code: "1469", name: "소프트웨어사업자(디지털콘텐츠개발서비스사업)" },
      { code: "0006", name: "실내건축공사업" },
      { code: "4444", name: "산업디자인전문회사(종합디자인분야)" },
    ]);
    expect(r.passes).toBe(true);
    expect(uniqueSatisfied(r.satisfiedBy)).toEqual([
      { name: "소프트웨어사업자(디지털콘텐츠개발서비스사업)", code: "1469", groups: 4 },
      { name: "실내건축공사업", code: "0006", groups: 4 },
      { name: "산업디자인전문회사(종합디자인분야)", code: "4444", groups: 1 },
    ]);
  });

  it("못 채운 그룹은 satisfiedBy에 없다", () => {
    expect(check(["건축공사업/0002"]).satisfiedBy).toEqual([]);
  });
});

describe("fail-open", () => {
  it("자격 정보가 없으면 통과시킨다", () => {
    const r = evaluateQualifications([], held.products, held.industries);
    expect(r.passes).toBe(true);
    expect(r.totalGroups).toBe(0);
  });
});
