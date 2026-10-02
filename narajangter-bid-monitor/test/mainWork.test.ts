import { describe, expect, it } from "vitest";
import { mainWorkOf } from "../src/matching/mainWork.js";
import type { NormalizedNotice } from "../src/api/types.js";

const held = [
  { code: "4990", name: "실내건축공사업" },
  { code: "4991", name: "금속창호·지붕건축물조립공사업" },
];
const notice = (businessType: string, mainCnsttyNm?: string) =>
  ({ noticeNo: "T", title: "t", businessType, sourceType: "본공고", raw: mainCnsttyNm ? { mainCnsttyNm } : {} }) as unknown as NormalizedNotice;

describe("공사 주공종 (2026-10-01 리스트 실측)", () => {
  it("지일 면허가 아닌 주공종을 알려준다", () => {
    expect(mainWorkOf(notice("공사", "조경식재ㆍ시설물공사업"), held)).toEqual({ name: "조경식재ㆍ시설물공사업", held: false });
    expect(mainWorkOf(notice("공사", "건축공사업"), held)?.held).toBe(false);
  });

  it("보유 면허면 held — 가운뎃점 표기 차이는 무시한다", () => {
    expect(mainWorkOf(notice("공사", "실내건축공사업"), held)?.held).toBe(true);
    expect(mainWorkOf(notice("공사", "금속창호ㆍ지붕건축물조립공사업"), held)?.held).toBe(true);
  });

  it("공사가 아니거나 주공종이 없으면 null", () => {
    expect(mainWorkOf(notice("용역", "건축공사업"), held)).toBeNull();
    expect(mainWorkOf(notice("공사"), held)).toBeNull();
  });
});
