import { describe, expect, it } from "vitest";
import { normalizeRawItem } from "../src/api/normalize.js";
import { BID_NOTICE_FIELD_CANDIDATES, PRE_STANDARD_FIELD_CANDIDATES } from "../src/api/fieldCandidates.js";

describe("normalizeRawItem", () => {
  it("후보 필드명으로 정상적으로 값을 추출한다", () => {
    const raw = {
      bidNtceNo: "20260001",
      bidNtceNm: "전시관 안내전광판 구매 설치",
      ntceInsttNm: "국립중앙과학관",
      bidClseDate: "20260810",
      presmptPrce: "35,000,000",
      asignBdgtAmt: "38,500,000",
      prdctClsfcNo: "5512190301",
      prdctClsfcNoNm: "안내전광판",
    };
    const notice = normalizeRawItem(raw, "물품", "본공고", BID_NOTICE_FIELD_CANDIDATES);
    expect(notice.noticeNo).toBe("20260001");
    expect(notice.title).toBe("전시관 안내전광판 구매 설치");
    expect(notice.institution).toBe("국립중앙과학관");
    expect(notice.budgetAmount).toBe(35_000_000);
    expect(notice.productClsfcNo).toBe("5512190301");
  });

  it("후보 필드가 없으면 Nm 접미사 휴리스틱으로 제목을 찾는다", () => {
    const raw = {
      someWeirdTitleNm: "새로운 필드명으로 바뀐 공고 제목",
      bidNtceNo: "20260002",
    };
    const notice = normalizeRawItem(raw, "용역", "본공고", BID_NOTICE_FIELD_CANDIDATES);
    expect(notice.title).toBe("새로운 필드명으로 바뀐 공고 제목");
  });

  it("공고번호를 전혀 찾을 수 없으면 안정적인 대체 ID를 생성한다", () => {
    const raw = { bidNtceNm: "제목만 있는 공고" };
    const a = normalizeRawItem(raw, "물품", "본공고", BID_NOTICE_FIELD_CANDIDATES);
    const b = normalizeRawItem(raw, "물품", "본공고", BID_NOTICE_FIELD_CANDIDATES);
    expect(a.noticeNo).toBe(b.noticeNo);
    expect(a.noticeNo).toMatch(/^GEN-/);
  });

  it("예산 금액에 콤마가 있어도 숫자로 변환된다", () => {
    const raw = { bidNtceNm: "t", presmptPrce: "1,234,567" };
    const notice = normalizeRawItem(raw, "물품", "본공고", BID_NOTICE_FIELD_CANDIDATES);
    expect(notice.budgetAmount).toBe(1_234_567);
  });

  it("예산 필드가 없으면 null이다", () => {
    const raw = { bidNtceNm: "t" };
    const notice = normalizeRawItem(raw, "물품", "본공고", BID_NOTICE_FIELD_CANDIDATES);
    expect(notice.budgetAmount).toBeNull();
  });

  // 2026-09-30 금액 기준을 추정가격(부가세 제외)으로 통일
  it("추정가격이 있으면 배정예산보다 추정가격을 쓴다", () => {
    const raw = { bidNtceNm: "t", presmptPrce: "100000000", asignBdgtAmt: "110000000" };
    expect(normalizeRawItem(raw, "용역", "본공고", BID_NOTICE_FIELD_CANDIDATES).budgetAmount).toBe(100_000_000);
  });

  it("사전규격은 추정가격이 없어 배정예산을 1.1로 나눠 환산한다", () => {
    const raw = { bfSpecRgstNo: "R1", prdctClsfcNoNm: "t", asignBdgtAmt: "385000000" };
    expect(normalizeRawItem(raw, "물품", "사전규격", PRE_STANDARD_FIELD_CANDIDATES).budgetAmount).toBe(350_000_000);
  });

  it("금액이 0으로 오면 정보 없음으로 보고 다음 필드를 쓴다", () => {
    const zeroPrice = { bidNtceNm: "t", presmptPrce: "0", asignBdgtAmt: "220000000" };
    expect(normalizeRawItem(zeroPrice, "물품", "본공고", BID_NOTICE_FIELD_CANDIDATES).budgetAmount).toBe(200_000_000);
    const allZero = { bidNtceNm: "t", presmptPrce: "0", asignBdgtAmt: "0" };
    expect(normalizeRawItem(allZero, "물품", "본공고", BID_NOTICE_FIELD_CANDIDATES).budgetAmount).toBeNull();
  });
});
