import { describe, expect, it } from "vitest";
import { lookupProductClass, parseLevel } from "../src/api/productClassApi.js";

// 2026-09-29 ThngListInfoService02 실측 응답 그대로
const unit10 = {
  response: {
    header: { resultCode: "00", resultMsg: "정상" },
    body: {
      items: [
        {
          dtilPrdctClsfcNo: "6010999901",
          dtilPrdctClsfcNoNm: "교육훈련장비",
          dtilPrdctClsfcNoEngNm: "Education training equipments",
          dtilPrdctClsfcNoNmDscrpt: "각종 훈련 및 교육에 사용되는 장비.",
          useYn: "Y",
          chgDate: "2019-06-11",
        },
      ],
      numOfRows: 5,
      pageNo: 1,
      totalCount: 1,
    },
  },
};
const unit4 = {
  response: {
    header: { resultCode: "00", resultMsg: "정상" },
    body: {
      items: [
        {
          prdctClsfcNo: "6010",
          prdctClsfcNoNm: "계발용,전문교습용보조기구,교재,교습용품및교습용보조품",
          prdctClsfcNoNmDscrpt: "교육의 목표를 효과적으로 달성하기 위하여 사용되는 도구 및 그 부속물.",
        },
      ],
      totalCount: 1,
    },
  },
};

describe("parseLevel", () => {
  it("세부품명(10자리) 응답에서 이름·해설을 읽는다", () => {
    expect(parseLevel(unit10, 10)).toEqual({
      digits: 10,
      code: "6010999901",
      name: "교육훈련장비",
      description: "각종 훈련 및 교육에 사용되는 장비.",
    });
  });

  it("상위 분류(2~8자리) 응답은 prdctClsfcNo 필드를 쓴다", () => {
    expect(parseLevel(unit4, 4)?.name).toBe("계발용,전문교습용보조기구,교재,교습용품및교습용보조품");
  });

  it("항목이 없으면 null", () => {
    expect(parseLevel({ response: { body: { items: [], totalCount: 0 } } }, 10)).toBeNull();
    expect(parseLevel({ response: { body: { items: "" } } }, 8)).toBeNull();
  });
});

describe("lookupProductClass", () => {
  it("10자리가 아니거나 키가 없으면 부르지 않는다", async () => {
    expect(await lookupProductClass("key", "60109999")).toBeNull();
    expect(await lookupProductClass("", "6010999901")).toBeNull();
  });
});
