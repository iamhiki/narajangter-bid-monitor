import { describe, expect, it } from "vitest";
import {
  analyzeQualificationText,
  classifiedItemsOf,
  findQualificationSection,
  pickNoticeDocAttachments,
} from "../src/matching/qualificationDoc.js";
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
    expect(r.requirements.map(({ kind, code, name, held, docName }) => ({ kind, code, name, held, docName }))).toEqual([
      { kind: "업종", code: "4444", name: "산업디자인전문회사(종합디자인분야)", held: true, docName: "종합디자인분야" },
      { kind: "업종", code: "4442", name: "산업디자인전문회사(환경디자인분야)", held: true, docName: "환경디자인분야" },
      { kind: "품명", code: "6012100201", name: "조형물", held: true, docName: "조형물" },
      { kind: "품명", code: "6010989901", name: null, held: false, docName: "실물모형" },
      { kind: "업종", code: null, name: "금속구조물·창호·온실공사업", held: true, docName: null },
    ]);
  });

  // 2026-09-29 실제 공고문 표기 그대로
  it.each([
    ["G2B분류번호 교 육훈련장비(세부품명번호: 6010999901)로 등록한 업체", "6010999901", "교육훈련장비"],
    ["G2B물품분류번호 10자리 조합놀이대 (세부품명번호 4924159701)를 제조물품 으로", "4924159701", "조합놀이대"],
    ["직접생산확인증명서[물품분류번호 4924159701 : 조합놀이대] 를 소지한 업체", "4924159701", "조합놀이대"],
    ["전광판 직접 생산증명서를 보유한 업체 (안내전광판, 물품분류번호: 5512190301) 마.", "5512190301", "안내전광판"],
    ["직접생산확인증명서[세부품명: 조형물, 세부품명번호: 6012100201 또는", "6012100201", "조형물"],
    ["업체 ․ 전시부스설치및디자인서비스(세부품명번호 : 7215409901) 또는", "7215409901", "전시부스설치및디자인서비스"],
    ["7215409901) 또는 전시홍보관설치및디자인서비스(세부품명번호 : 7215409902) 이어야", "7215409902", "전시홍보관설치및디자인서비스"],
  ])("공고문에 적힌 이름을 읽는다: %s", (text, code, name) => {
    const r = analyze(`참가자격 가. ${text}`);
    expect(r.requirements.find((x) => x.code === code)?.docName).toBe(name);
  });

  describe("요건 종류 (등록 / 직접생산 / 면허)", () => {
    const basesOf = (text: string, code: string) => analyze(`참가자격 가. ${text}`).requirements.find((x) => x.code === code)?.bases;

    it("'…로 등록한 업체'는 등록 — 나라장터에 세부품명만 추가하면 된다 (울산과학관)", () => {
      expect(
        basesOf(
          "같은 법 시행령 제92조에 해당하지 않는 업체이어 야 합니다. 국가종합전자조달시스템 입찰참가자격등록규정에 의하여 G2B분류번호 교 육훈련장비(세부품명번호: 6010999901)로 등록한 업체이어야 합니다.",
          "6010999901"
        )
      ).toEqual(["등록"]);
    });

    it("직접생산확인증명서 안의 코드는 직접생산 (태조왕건 — 괄호 안 두 번째 코드도)", () => {
      const text = "3) 「중소기업제품 구매촉진 및 판로지원에 관한 법률」제9조에 의한 직접생산확인증명서[세부품명: 조형물, 세부품명번호: 6012100201 또는 세부품명: 실물모형, 세부품명번호: 6010989901] 를 소지한 자";
      expect(basesOf(text, "6012100201")).toEqual(["직접생산"]);
      expect(basesOf(text, "6010989901")).toEqual(["직접생산"]);
    });

    it("'직접 생산증명서'처럼 띄어 써도 직접생산 (재해문자전광판)", () => {
      expect(basesOf("라. 전광판 직접 생산증명서를 보유한 업체 (안내전광판, 물품분류번호: 5512190301) 마.", "5512190301")).toEqual(["직접생산"]);
    });

    it("같은 코드가 등록·직접생산 두 항목에 나오면 둘 다, 앞 항목의 직접생산이 뒤 항목에 번지지 않는다 (유교랜드)", () => {
      const text =
        "○ G2B물품분류번호 10자리 조합놀이대 (세부품명번호 4924159701)를 제조물품 으로 입찰참가 등록한 업체 " +
        "○ 「 중소기업제품 구매촉진 및 판로지원에 관한 법률」 제9조의 규정에 따라 직접생산확인증명서[물품분류번호 4924159701 : 조합놀이대] 를 소지한 업체";
      expect(basesOf(text, "4924159701")).toEqual(["등록", "직접생산"]);
      const onlyReg = "○ 직접생산확인증명서를 소지한 업체 ○ 교육훈련장비(세부품명번호: 6010999901)로 등록한 업체";
      expect(basesOf(onlyReg, "6010999901")).toEqual(["등록"]);
    });

    it("업종코드는 면허", () => {
      expect(basesOf("건설산업기본법에 의한 [실내건축공사(4990)]을 등록", "4990")).toEqual(["면허"]);
    });
  });

  it("미보유 세부품명번호는 같은 분류 계층의 보유 품목을 붙인다 (앞 8→6→4자리 중 가장 가까운 것)", () => {
    const products: CodeEntry[] = [
      { code: "6010989901", name: "실물모형및전시물" },
      { code: "6010393101", name: "동물표본" },
      { code: "4924159801", name: "기타놀이기구" },
    ];
    const r = analyzeQualificationText(
      "참가자격 가. 교육훈련장비(세부품명번호: 6010999901) 나. 놀이기구(세부품명번호: 4924159702)",
      "",
      products,
      heldIndustries
    );
    expect(r.requirements.find((x) => x.code === "6010999901")?.related).toEqual({
      level: "같은 중분류",
      items: [
        { code: "6010989901", name: "실물모형및전시물" },
        { code: "6010393101", name: "동물표본" },
      ],
    });
    expect(r.requirements.find((x) => x.code === "4924159702")?.related).toEqual({
      level: "같은 소분류",
      items: [{ code: "4924159801", name: "기타놀이기구" }],
    });
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

describe("사전규격", () => {
  // 2026-09-29 사전규격 실측 응답 형태
  const pre = {
    sourceType: "사전규격",
    raw: {
      specDocFileUrl1: "https://www.g2b.go.kr/pn/pnz/pnza/UntyAtchFile/downloadFile.do?bfSpecRegNo=R26BD00275861&f=1",
      specDocFileUrl2: "https://www.g2b.go.kr/pn/pnz/pnza/UntyAtchFile/downloadFile.do?bfSpecRegNo=R26BD00275861&f=2",
      prdctDtlList: "[1^6010989901^실물모형및전시물][2^6010999901^교육훈련장비]",
      bidNtceNoList: "R26BK01742555",
    },
  } as unknown as NormalizedNotice;

  it("파일명 없이 URL만 오는 첨부(specDocFileUrlN)를 읽을 대상으로 잡는다", () => {
    expect(pickNoticeDocAttachments(pre).map((a) => a.url.slice(-3))).toEqual(["f=1", "f=2"]);
  });

  it("공고가 분류된 세부품명을 prdctDtlList에서 읽는다", () => {
    expect(classifiedItemsOf(pre)).toEqual([
      { code: "6010989901", name: "실물모형및전시물" },
      { code: "6010999901", name: "교육훈련장비" },
    ]);
  });

  it("본공고는 dtilPrdctClsfcNo에서 읽는다", () => {
    const bid = { sourceType: "본공고", raw: { dtilPrdctClsfcNo: "6010999901", dtilPrdctClsfcNoNm: "교육훈련장비" } } as unknown as NormalizedNotice;
    expect(classifiedItemsOf(bid)).toEqual([{ code: "6010999901", name: "교육훈련장비" }]);
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

// 2026-09-29 거제 지심도 산마루문화놀이터 제안공모(사전규격) 규격서 발췌
describe("설계공모 참가자격", () => {
  const text =
    "4. 설계 공모 참가자의 자격 가. 공모 공고일 현재 「건 축사법」 제7조에 따른 건축사 면허를 소지하고, 제23조에 의해 건축사사무소(등록업체)를 개설하고 있는 자에 한해 응모할 수 있다. " +
    "나. 응모신청서 접수일 기준 현재 등록취소, 휴업, 폐업, 업무정지 및 자격정지와 기타 행정관청의 행정처분을 받은 자는 등록 할 수 없다. " +
    "바. 당선자가 전기·정보 통신·소방 분야의 설계에 대한 자격이 없는 경우 … 「정보통신공사 업법」 제2조제7호에 따른 용역업자 … 설계업을 등록한 자 와 공동도급 " +
    "아. 단독 또는 공동응모 중 한 가지 방식으로만 참가할 수 있으며, 중복하여 응모한 사실이 확인될 경우 해당 업체의 참가자격은 박탈된다. " +
    "5. 응모 신청서 등록 및 현장설명회 등록 일시 등록처 등록방법 등록";

  it("'참가자의 자격' 제목을 찾고, '참가자격은 박탈된다' 벌칙 문구는 고르지 않는다", () => {
    expect(findQualificationSection(text)).toMatch(/^참가자의 자격 가\./);
  });

  it("코드 없이 건축사 면허만 거는 공고를 미보유 면허 요건으로 잡는다", () => {
    const r = analyze(findQualificationSection(text)!, text);
    expect(r.requirements).toEqual([
      { kind: "업종", code: null, name: null, held: false, docName: "건축사사무소 개설(건축사법)", related: null, bases: ["면허"] },
    ]);
  });
});
