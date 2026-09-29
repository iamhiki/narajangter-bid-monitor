import { describe, expect, it } from "vitest";
import { dedupeNotices } from "../src/api/fetchNotices.js";
import type { FetchResult, NormalizedNotice } from "../src/api/types.js";

function notice(noticeNo: string, ord: string, kind: string, title = "공고"): NormalizedNotice {
  return {
    noticeNo,
    title,
    institution: null,
    businessType: "공사",
    sourceType: "본공고",
    postedAt: null,
    deadline: null,
    budgetAmount: null,
    detailUrl: null,
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: null,
    raw: { bidNtceOrd: ord, ntceKindNm: kind },
  };
}

const run = (notices: NormalizedNotice[]) =>
  dedupeNotices([{ businessType: "공사", notices, failed: false } as FetchResult])[0]!.notices;

describe("dedupeNotices", () => {
  it("취소공고(차수가 올라간 최신 상태)면 그 공고번호를 뺀다 — 2026-09-29 건양대 실측", () => {
    const out = run([
      notice("R26BK01744615", "000", "등록공고", "건양대학교 건양회관 5층 인테리어 공사"),
      notice("R26BK01744615", "001", "취소공고", "건양대학교 건양회관 5층 인테리어 공사"),
      notice("R26BK01744617", "000", "등록공고", "건양대학교 건양회관 5층 인테리어 공사(전기)"),
    ]);
    expect(out.map((n) => n.noticeNo)).toEqual(["R26BK01744617"]);
  });

  it("취소공고가 먼저 와도 뺀다", () => {
    const out = run([notice("A", "001", "취소공고"), notice("A", "000", "등록공고")]);
    expect(out).toEqual([]);
  });

  it("변경공고는 최신 차수로 남긴다", () => {
    const out = run([notice("B", "000", "등록공고", "옛 제목"), notice("B", "001", "변경공고", "바뀐 제목")]);
    expect(out.map((n) => [n.noticeNo, n.title])).toEqual([["B", "바뀐 제목"]]);
  });

  it("공고 종류가 없는 자료(사전규격 등)는 그대로 둔다", () => {
    const n = { ...notice("C", "", ""), raw: {} };
    expect(run([n, n])).toHaveLength(1);
  });
});
