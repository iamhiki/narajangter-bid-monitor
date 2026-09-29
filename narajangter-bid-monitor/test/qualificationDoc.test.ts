import { describe, expect, it } from "vitest";
import { analyzeQualificationText, findQualificationSection, pickNoticeDocAttachments } from "../src/matching/qualificationDoc.js";
import type { CodeEntry } from "../src/config/loadJsonConfig.js";
import type { NormalizedNotice } from "../src/api/types.js";

// 아래 문구는 2026-09-29 실제 공고문에서 발췌했다 (업체명·사업자번호는 가림).
const heldProducts: CodeEntry[] = [
  { code: "6012100201", name: "조형물" },
  { code: "5512190301", name: "안내전광판" },
];
const heldIndustries: CodeEntry[] = [
  { code: "4442", name: "산업디자인전문회사(환경디자인분야)" },
  { code: "4444", name: "산업디자인전문회사(종합디자인분야)" },
  { code: "4990", name: "실내건축공사업" },
  { code: "0036", name: "정보통신공사업" },
  { code: "1440", name: "금속구조물·창호·온실공사업" },
];

const analyze = (section: string, full = section) => analyzeQualificationText(section, full, heldProducts, heldIndustries);

describe("findQualificationSection", () => {
  it("청렴서약의 '참가자격 제한' 대신 실제 참가자격 항목을 고른다", () => {
    const text =
      "부정당업자의 입찰참가자격 제한 처분을 받겠습니다. 담합 등 행위 시 입찰참가자격 제한. " +
      "1. 입찰에 부치는 사항 … 3. 입찰 참가자격 가. 국가계약법시행령 제12조에 의한 유자격 업체 " +
      "마. 건설산업기본법에 의한 [실내건축공사(4990)]을 등록하고 면허를 소지한 업체";
    expect(findQualificationSection(text)).toMatch(/^참가자격 가\./);
  });

  it("자격 관련 단어가 거의 없으면 null", () => {
    expect(findQualificationSection("참가자격은 별도 안내합니다.")).toBeNull();
  });
});

describe("analyzeQualificationText", () => {
  it("업종코드·세부품명번호·코드 없는 업종명을 모두 잡고 보유 여부를 붙인다", () => {
    const r = analyze(
      "참가자격 가. 1) 산업디자인 전문회사로 종합디자인분야 [업종코드 4444] 또는 환경디자인분야 [업종코드 4442] 로 등록 " +
        "2) 전문건설업(강구조물공사업, 금속구조물·창호·온실공사업 중에서 1개 업종) 3) 직접생산확인증명서[세부품명: 조형물, 세부품명번호: 6012100201 " +
        "또는 세부품명: 실물모형, 세부품명번호: 6010989901]"
    );
    expect(r.requirements).toEqual([
      { kind: "업종", code: "4444", name: "산업디자인전문회사(종합디자인분야)", held: true },
      { kind: "업종", code: "4442", name: "산업디자인전문회사(환경디자인분야)", held: true },
      { kind: "품명", code: "6012100201", name: "조형물", held: true },
      { kind: "품명", code: "6010989901", name: null, held: false },
      { kind: "업종", code: null, name: "금속구조물·창호·온실공사업", held: true },
    ]);
  });

  it("'[실내건축공사(4990)]'처럼 업종명 뒤 괄호 코드도 잡는다", () => {
    const r = analyze("참가자격 가. 건설산업기본법에 의한 [실내건축공사(4990)]을 등록 · 정보통신공사업(0036) 등록 업체");
    expect(r.requirements.map((x) => x.code)).toEqual(["4990", "0036"]);
  });

  it("지역제한은 공고문 전체에서 찾는다 (본점 소재지 문구)", () => {
    const full =
      "마. 본 입찰은 지역제한 입찰이며, 법인등기부상 본 점 소재지(개인사업자인 경우 사업자등록증상 사업장 소재지)가 [충청남도] 또는 [세 종특별시]에 있는 업체여야 합니다. " +
      "3. 입찰 참가자격 가. 유자격 업체 나. [실내건축공사(4990)] 등록";
    expect(analyze("참가자격 가. [실내건축공사(4990)] 등록", full).region).toBe("충청남도");
  });

  it("공사현장 주소의 지명은 지역제한으로 보지 않는다", () => {
    expect(analyze("참가자격 가. 등록 업체", "공사현장: 충남 논산시 대학로 121 참가자격 가. 등록 업체").region).toBeNull();
  });

  it("조합추천 지명경쟁을 알아보고, 명단에 지일이 있는지 본다", () => {
    const text =
      "참가자격 가. 본 입찰은 지명경쟁 입찰 로서, 한국전자산업협동조합을 통해 추천받은 아래 5개 업체만 입찰에 참가할 수 있습니다. 업체명 ㈜가나 ㈜다라";
    expect(analyze(text)).toMatchObject({ designated: true, jiilDesignated: false });
    expect(analyze(text + " ㈜지일")).toMatchObject({ designated: true, jiilDesignated: true });
    expect(analyze("참가자격 가. 일반경쟁 입찰로서 등록 업체").designated).toBe(false);
  });
});

describe("pickNoticeDocAttachments", () => {
  it("공고문만 고르고 HWPX > PDF > HWP 순으로 세운다", () => {
    const raw: Record<string, string> = {
      ntceSpecFileNm1: "[붙임1] 공고문.hwp", ntceSpecDocUrl1: "u1",
      ntceSpecFileNm2: "[붙임1-1] 공고문.pdf", ntceSpecDocUrl2: "u2",
      ntceSpecFileNm3: "[붙임2] 제안요청서.hwp", ntceSpecDocUrl3: "u3",
      ntceSpecFileNm4: "공고문.hwpx", ntceSpecDocUrl4: "u4",
    };
    const notice = { raw } as unknown as NormalizedNotice;
    expect(pickNoticeDocAttachments(notice).map((a) => a.url)).toEqual(["u4", "u2", "u1"]);
  });
});
