import { describe, expect, it } from "vitest";
import { BID_NOTICE_FIELD_CANDIDATES, PRE_STANDARD_FIELD_CANDIDATES } from "../src/api/fieldCandidates.js";
import { pickString } from "../src/api/fieldResolver.js";

describe("세부품명번호 필드 후보", () => {
  // 실제 응답 모양 (2026-09-22 실측, 본공고 물품)
  const raw = {
    dtilPrdctClsfcNo: "3911160501",
    dtilPrdctClsfcNoNm: "LED경관조명기구",
    prdctClsfcLmtYn: "Y",
    indstrytyLmtYn: "",
    purchsObjPrdctList: "[1^3911160501^LED경관조명기구]",
  };

  it("실제 필드명 dtilPrdctClsfcNo를 읽는다", () => {
    // 기존 후보 `prdctClsfcNo`는 응답에 없어서 7,376건 전부 null이었고,
    // 그 탓에 코드 매칭이 0건 → "강력추천" 등급이 구조적으로 나올 수 없었다.
    expect(pickString(raw, BID_NOTICE_FIELD_CANDIDATES.productClsfcNo)).toBe("3911160501");
    expect(pickString(raw, BID_NOTICE_FIELD_CANDIDATES.productClsfcName)).toBe("LED경관조명기구");
    expect(pickString(raw, PRE_STANDARD_FIELD_CANDIDATES.productClsfcNo)).toBe("3911160501");
  });

  it("업종 텍스트 후보에 Y/N 플래그가 없다", () => {
    // indstrytyLmtYn은 업종제한 '여부'라 업종명 자리에 오면 "Y"/"N"이 매칭 대상이 된다.
    for (const fields of [BID_NOTICE_FIELD_CANDIDATES, PRE_STANDARD_FIELD_CANDIDATES]) {
      expect(fields.industryText).not.toContain("indstrytyLmtYn");
      expect(fields.industryText).not.toContain("prdctClsfcLmtYn");
    }
  });

  it("업종명이 없는 응답에서는 null이지 Y/N이 아니다", () => {
    expect(pickString(raw, BID_NOTICE_FIELD_CANDIDATES.industryText)).toBeNull();
  });
});
