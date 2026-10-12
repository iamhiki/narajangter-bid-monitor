import { describe, expect, it } from "vitest";
import { d2bRefOf, parseD2bAttachmentLinks } from "../src/api/d2bPreStandard.js";
import type { NormalizedNotice } from "../src/api/types.js";

const notice = (raw: Record<string, unknown>) => ({ noticeNo: "R26BD00281727", sourceType: "사전규격", raw }) as unknown as NormalizedNotice;

describe("d2bRefOf", () => {
  it("군 기관 사전규격의 참조번호를 국방전자조달 번호로 나눈다", () => {
    expect(d2bRefOf(notice({ refNo: "PS2026UMM40015" }))).toEqual({ year: "2026", dprtCode: "UMM", dcsnNumb: "40015" });
  });
  it("나라장터 자체 규격은 null", () => {
    expect(d2bRefOf(notice({ refNo: "" }))).toBeNull();
    expect(d2bRefOf(notice({ refNo: "2026-0123" }))).toBeNull();
    expect(d2bRefOf(notice({}))).toBeNull();
  });
});

describe("parseD2bAttachmentLinks", () => {
  it("상세 화면의 첨부 링크와 파일명 (2026-10-12 실측 HTML)", () => {
    const html = `<td class="taL">
      <a href="/common/downloadSes.do?fileIdxx=UP20260024475569">
      사전규격공개(26F175-B).zip
    </td>`;
    expect(parseD2bAttachmentLinks(html)).toEqual([
      { path: "/common/downloadSes.do?fileIdxx=UP20260024475569", name: "사전규격공개(26F175-B).zip" },
    ]);
  });
});

import { DEFERRED_TO_NOTICE } from "../src/matching/qualificationDoc.js";

describe("DEFERRED_TO_NOTICE", () => {
  it("참가자격을 공고문으로 미룬 문장", () => {
    expect(DEFERRED_TO_NOTICE.test("1.1.2 제안참가자격 : 공고문 참조 1.1.3 공동도급")).toBe(true); // 장흥댐 물문화관
    expect(DEFERRED_TO_NOTICE.test("입찰참가자격은 입찰공고서에 따름")).toBe(true);
  });
  it("자격이 직접 적힌 문장은 아니다", () => {
    expect(DEFERRED_TO_NOTICE.test("입찰참가자격 가. 실내건축공사업을 등록한 업체")).toBe(false);
    expect(DEFERRED_TO_NOTICE.test("참가 자격 확인 서류 우리공사 전자조달 시스템을 통해 제출")).toBe(false);
  });
});
