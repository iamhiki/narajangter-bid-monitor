import { describe, expect, it } from "vitest";
import {
  evaluateQualifications,
  extractCode,
  missingLabels,
  qualificationLayout,
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

describe("qualificationLayout (화면 팝업 묶음)", () => {
  const lay = (groups: { groupNo: string; allowedNames: string[]; rows?: string[][] }[]) =>
    qualificationLayout(groups, held.products, held.industries);

  it("모든 방법에 공통인 업종은 '모두 필요', 방법마다 다른 업종은 '이 중 하나'로 묶는다 (울산과학관형)", () => {
    const g = (no: string, design: string) => ({
      groupNo: no,
      allowedNames: [],
      rows: [["실내건축공사업/0006"], ["정보통신공사업/0036"], [design]],
    });
    const r = lay([g("1", "산업디자인(환경)/4442"), g("2", "산업디자인(종합)/4444"), g("3", "산업디자인(환경)/4442")]);
    expect(r.methods).toBeNull();
    expect(r.blocks).toEqual([
      {
        kind: "all",
        met: true,
        options: [
          { label: "실내건축공사업(0006)", held: true },
          { label: "정보통신공사업(0036)", held: true },
        ],
      },
      {
        kind: "any",
        met: false,
        options: [
          { label: "산업디자인(환경)(4442)", held: false },
          { label: "산업디자인(종합)(4444)", held: false },
        ],
      },
    ]);
  });

  it("허용업종이 있는 공통 순번은 따로 '이 중 하나'", () => {
    const r = lay([{ groupNo: "1", allowedNames: [], rows: [["건축공사업/0002", "실내건축공사업/0006"]] }]);
    expect(r.blocks).toEqual([
      { kind: "any", met: true, options: [{ label: "건축공사업(0002)", held: false }, { label: "실내건축공사업(0006)", held: true }] },
    ]);
  });

  it("방법마다 다른 부분이 두 순번 이상이면 방법별로 그대로 준다", () => {
    const r = lay([
      { groupNo: "1", allowedNames: [], rows: [["토목공사업/0001"]] },
      { groupNo: "2", allowedNames: [], rows: [["상하수도설비공사업/4996"], ["지반조성포장공사업/4989"]] },
    ]);
    expect(r.blocks).toEqual([]);
    expect(r.methods?.map((m) => m.map((row) => row.map((o) => o.label)))).toEqual([
      [["토목공사업(0001)"]],
      [["상하수도설비공사업(4996)"], ["지반조성포장공사업(4989)"]],
    ]);
  });
});

describe("qualificationLayout — 조합으로 펼쳐 실린 그룹", () => {
  it("'A + (B 또는 C) + (D 또는 E)'를 조합마다 그룹으로 실은 공고는 자리별 '이 중 하나'로 다시 접는다 (R26BK01662507형)", () => {
    const groups = [
      ["1468", "4444"],
      ["1469", "4444"],
      ["1468", "4442"],
      ["1469", "4442"],
    ].map(([sw, design], i) => ({
      groupNo: String(i + 1),
      allowedNames: [],
      rows: [["실내건축공사업/0006"], [`소프트웨어/${sw}`], [`산업디자인/${design}`]],
    }));
    const r = qualificationLayout(groups, held.products, held.industries);
    expect(r.methods).toBeNull();
    expect(r.blocks.map((b) => [b.kind, b.options.map((o) => o.label)])).toEqual([
      ["all", ["실내건축공사업(0006)"]],
      ["any", ["소프트웨어(1468)", "소프트웨어(1469)"]],
      ["any", ["산업디자인(4444)", "산업디자인(4442)"]],
    ]);
  });

  it("조합이 빠져 있으면 접지 않는다 — 없는 조합을 허용하는 것처럼 보이면 안 된다", () => {
    const groups = [
      ["1468", "4444"],
      ["1469", "4444"],
      ["1468", "4442"],
    ].map(([sw, design], i) => ({ groupNo: String(i + 1), allowedNames: [], rows: [[`소프트웨어/${sw}`], [`산업디자인/${design}`]] }));
    const r = qualificationLayout(groups, held.products, held.industries);
    expect(r.methods).toHaveLength(3);
  });
});
