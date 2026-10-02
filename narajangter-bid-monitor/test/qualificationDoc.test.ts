import { describe, expect, it } from "vitest";
import {
  meetsRegion,
  findPerformanceRequirements,
  findPerformanceReviewDeadline,
  parseWon,
  analyzeQualificationText,
  classifiedItemsOf,
  findQualificationSection,
  pickNoticeDocAttachments,
  findSizeLimit,
  quoteAround,
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

  it("'입찰참가자격 2-1. 아래의 자격을' 같은 절 번호 형식도 본문으로 본다 (국립중앙박물관 공고 실측)", () => {
    const text =
      "9-3. 입찰참가자격의 판단기준일은 입찰참가자격등록 마감일이며 마감일까지 참가자격을 갖추지 않은 경우 무효입찰입니다. " +
      "2. 입찰참가자격 2-1. 아래의 자격을 모두 갖춘 자이어야 합니다. 비디오물제작업(업종코드 : 3244) 등록한 자. 직접생산확인증명서를 소지한 자.";
    expect(findQualificationSection(text)).toMatch(/^참가자격 2-1\./);
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
    expect(analyze("참가자격 가. [실내건축공사(4990)] 등록", full).region).toBe("충청남도 또는 세종");
  });

  it("'세부품명번호 10자리 6010989901'처럼 자릿수 설명이 끼어도 품명 코드를 읽는다 (울진해양과학관 재공고서)", () => {
    const r = analyze(
      "참가자격 ① 나라장터에 입찰참가자격등록 마감일시까지 실물모형및전시물(세부품명번호 10자리 6010989901)을 제조물 품 으로 입찰참가 등록한 자 " +
        "③ 직접생산확인증명서[세부품명 : 실물모형및전시물, 세부품명번호 10자리 : 6010989901 ] 을 소지한 자 " +
        "④ 실내건축공사업[업종코드 4990] 으로 입찰참가 등록 한 자"
    );
    expect(r.requirements.filter((x) => x.kind === "품명").map((x) => x.code)).toEqual(["6010989901"]);
    expect(r.requirements.filter((x) => x.kind === "업종").map((x) => x.code)).toEqual(["4990"]);
  });

  it("PDF 추출로 글 순서가 섞인 '( )( : 4442)'·'번호 자리 10 (6010989901)'도 코드로 읽는다 (울산박물관 재공고문)", () => {
    const r = analyze(
      "참가자격 나 나라장터에 산업디자인진흥법 제 조에 따라 산업디자인전문회사 환경디자인분야 업종코드 또는 산업디자인전문 ( )( : 4442) " +
        "회사 종합디자인분야 업종코드 으로 등록된 업체 ( )( : 4444) 라 직접생산확인증명서 세부품명 실물모형및전시물 세부품명 10 [ : , 번호 자리 10 (6010989901)"
    );
    expect(r.requirements.map((x) => x.code)).toEqual(["4442", "4444", "6010989901"]);
    expect(r.requirements.find((x) => x.code === "6010989901")!.kind).toBe("품명");
  });

  it("직접생산 품명을 여러 개 나열해도 모두 직접생산으로, 이름과 함께 읽는다 (수정유스센터 공고)", () => {
    const r = analyze(
      "참가자격 6)「중소기업제품 구매촉진 및 판로지원에 관한 법률」제9조 및 같은 법 시행령 제10조에 의한 직접생산확인증명서 세부품명 " +
        "영상정보디스플레이 장치(4511189301), 교육용로봇(6010621401), 안내전광판(5512190301)을 모두 보유한 업체"
    );
    expect(r.requirements.map((x) => [x.code, x.docName, x.bases])).toEqual([
      ["4511189301", "영상정보디스플레이장치", ["직접생산"]],
      ["6010621401", "교육용로봇", ["직접생산"]],
      ["5512190301", "안내전광판", ["직접생산"]],
    ]);
  });

  it("등록 항목 뒤 직접생산확인서에 번호만 다시 쓴 것도 직접생산으로, 이름은 '의하여' 뒤만 (서울과학기술대 상징 조형물)", () => {
    const r = analyze(
      "참가자격 나. 국가종합전자조달시스템 입찰참가등록자격등록규정에의하여조형물(세부품명 번호 6012100201)를 제조물품으로 등록하고, " +
        "｢ 판로지원법 ｣ 제9조 및 같은 법 시행령 제10조에 따른 직접생산확인서(조형물(6012100201))를 소지한 업체"
    );
    expect(r.requirements.map((x) => [x.code, x.docName, x.bases])).toEqual([["6012100201", "조형물", ["등록", "직접생산"]]]);
  });

  it("지역제한은 본점 소재지로 판정하고, 같은 지역의 다른 표기(강원도·강원특별자치도)는 같게 본다", () => {
    expect(meetsRegion("강원도", "강원특별자치도")).toBe(true);
    expect(meetsRegion("경기도", "강원특별자치도")).toBe(false);
    expect(meetsRegion("충청남도 또는 세종", "세종특별자치시")).toBe(true);
    expect(meetsRegion("충청북도", "충청남도")).toBe(false);
    expect(meetsRegion("경기도", null)).toBeNull();
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

  it("지명 업체 수는 제목 줄이 아니라 '…N개 업체만 입찰' 문장에서 읽는다 (시흥아트센터 공고 실측)", () => {
    const full =
      "시흥시 공고 제2026 - 2529호 물품 제조 지명경쟁(조합추천) 입찰 공고 우리 시가 추진하는 사업의 계약상대자 선정을 위하여 아래와 같이 공고합니다. " +
      "3 입찰 참가자격 가. 본 건은 「지방자치단체를 당사자로 하는 계약에 관한 법률 시행령」제22조 의 규정에 의한 지명경쟁 입찰로서, 한국전시문화사업협동조합의 추천을 받은 5개 업체만 입찰가능합니다. 연번 업체명";
    expect(analyze("참가자격 가. 등록 업체", full)).toMatchObject({ designated: true, designatedCount: 5 });
    expect(analyze("참가자격 가. 물품제조 지명경쟁(조합추천) 입찰 공고")).toMatchObject({ designated: true, designatedCount: null });
  });

  it("입찰참가신청서 양식의 '일반․제한․지명 경쟁 입찰에 참가하고자'는 지명경쟁이 아니다 (국립박물관 공고 실측)", () => {
    const form = "참가자격 가. 등록 업체. 본인은 위의 번호로 공고(지명통지)한 귀 박물관의 일반․제한․지명 경쟁 입찰에 참가하고자 합니다.";
    expect(analyze(form)).toMatchObject({ designated: false, designatedCount: null });
  });

  it("라벨 없이 \"'안내전광판(5512190301)' 제조물품으로 등록\"한 품명도 읽는다 (코레일유통 공고 실측)", () => {
    const r = analyze("참가자격 사. 국가종합전자조달(나라장터)에 '안내전광판(5512190301)' 제조물품으로 등록한 자 아. 등록 업체");
    expect(r.requirements.map((x) => [x.code, x.name, x.bases])).toEqual([["5512190301", "안내전광판", ["등록"]]]);
  });

  it("업종 이름 앞 '…마감일 전일까지'는 이름이 아니다", () => {
    const r = analyze("참가자격 3) 나라장터에 입찰서제출마감일전일까지기타자유업종(업종코드 : 9999)으로 등록한 자");
    expect(r.requirements[0]).toMatchObject({ code: "9999", docName: "기타자유업종" });
  });

  it("문장 인용은 '…소재한 자. 2)'의 '자.'에서 끝낸다 (경남 공고문 실측 — 항목 기호로 보면 '소재한'에서 잘린다)", () => {
    const text = "1) 입찰공고일 전일부터 법인등기부상 본점소재지를 계속 경상남도에 소재한 자. 2) 비디오물제작업 등록 업체";
    const at = text.indexOf("경상남도");
    expect(quoteAround(text, at, at + 4)).toBe("입찰공고일 전일부터 법인등기부상 본점소재지를 계속 경상남도에 소재한 자.");
  });
});

describe("기업 규모 요건 (2026-10-01 첨부 462개 실측 표기)", () => {
  const sizeOf = (s: string) => findSizeLimit(`참가자격 가. ${s}`);
  it("'소기업(자) 또는 소상공인'은 소기업 — 확인서 이름이 '중소기업·소상공인 확인서'여도 (서울과기대)", () => {
    expect(
      sizeOf("「중소기업기본법」 제2조에 따른 소기업자 또는 「소상공인 보호 및 지원에 관한 법률」 제2조에 따른 소상공인으로서 발급된 <중소기업·소상공인 확인서>를 소지한 자")
    ).toEqual({ level: "소기업", alsoAllowed: [], conditional: false });
  });
  it("'중·소기업 또는 소상공인', '중.소기업자 및', '중기업·소기업 또는', '중소기업자로서'는 중소기업", () => {
    for (const s of [
      "「중소기업기본법」 제2조에 따른 중·소기업 또는 「소상공인기본법」 제2조에 따른 소상공인으로서",
      "「중소기업기본법」제2조에 따른 중.소기업자 및 「소상공인 보호 및 지원에 관한 법률」",
      "「중소기업기본법」제2조에 따른 중기업·소기업 또는 「소상공인 보호 및 지원에 관한 법률」",
      "시행령 제2조 규정에 따른 중소기업자로서 발급된 것으로 중기업, 소기업 또는 소상공인 확인서를 소지한 업체",
    ]) {
      expect(sizeOf(s)?.level, s).toBe("중소기업");
    }
  });
  it("함께 허용된 벤처기업·창업기업과, '1억원 미만인 경우' 같은 조건을 읽는다", () => {
    expect(sizeOf("「중소기업기본법」 제2조에 따른 소기업자, 「소상공인기본법」제2조에 따른 소상공인, 「벤처기업육성에 관한 특별법」에 따른 벤처기업 또는 창업기업으로써")).toEqual({
      level: "소기업",
      alsoAllowed: ["벤처기업", "창업기업"],
      conditional: false,
    });
    expect(sizeOf("추정가격이 1억원 미만인 물품 또는 용역을 조달하려는 경우에는 「중소기업기본법」제2조에 따른 중소기업 또는 「소상공인기본법」제2조에 따른 소상공인으로서")?.conditional).toBe(true);
  });
  it("OCR이 가운뎃점을 '•'로 읽어도 알아본다 (코레일유통 공고 OCR 실측)", () => {
    expect(sizeOf("「중소기업제품 구매촉진 및 판로지원에 관한 법률」 제2조에 따른 중소기업 • 소상공인 으로 확인서를 소지한 업체")?.level).toBe("중소기업");
  });
  it("법령 이름(「중소기업제품 구매촉진…」)만 있으면 요건이 아니다", () => {
    expect(sizeOf("「중소기업제품 구매촉진 및 판로지원에 관한 법률」 제9조에 따른 직접생산확인증명서를 소지한 업체")).toBeNull();
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

describe("실적 요건", () => {
  // 2026-10-01 캐시된 실제 공고문 문장
  it("전시장 제작·설치 단일 건 10억원 준공실적 (기간 앞 항목에서)", () => {
    const text =
      "7) 국세 체납이 없는 업체 8) 입찰공고일 기준으로 최근 3년 이내에 건축법 시행령 제3조의 5에 따른 [별표 1]의 5. 문화 및 집회시설의 “라”에 의한 " +
      "전시장(박물관, 미술관, 과학관, 그 밖에 이와 비슷한 것을 말한다)의 제작·설치 실적이 단일 건으로 10억원 이상 준공실적이 있는 업체 m 제안서 제출일 기준 국세 및 지방세 체납 사실이 없는 업체";
    const [r, ...rest] = findPerformanceRequirements(text);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ years: 3, single: true, minAmountWon: 1_000_000_000 });
    expect(r!.sentence).toMatch(/^입찰공고일 기준으로 최근 3년/);
  });

  it("원 단위 금액과 실적심사신청서 마감", () => {
    const text =
      "를 소지한 자 ○ 입찰공고일 기준 최근 10년 이내 단일 계약 건으로 추정가격 110,121,000원 이상(부가가치세 제외) 실물모형및전시물 을 제조하여 납품 완료한 실적을 보유한 업체 " +
      "※ 이 입찰은 실적제한 입찰이며, 실적심사신청서를 나라장터를 통하여 2026/10/06 18:00 까지 전자로 제출한 업체만 입찰에 참여할 수 있으며";
    expect(findPerformanceRequirements(text)).toMatchObject([{ years: 10, single: true, minAmountWon: 110_121_000 }]);
    expect(findPerformanceReviewDeadline(text)).toBe("2026/10/06 18:00");
  });

  it("평가 배점표·참여인력 조건의 '실적'은 요건으로 보지 않는다", () => {
    expect(findPerformanceRequirements("주요사업 실적 5점 최근3년간 단일 사업2억원 이상 실적 보유 시5점, 미 보유 시3점")).toEqual([]);
    expect(findPerformanceRequirements("- 책임연구원은 정책효과분석 연구 수행 실적을 보유한 자로 구성")).toEqual([]);
  });

  it("금액 표기", () => {
    expect(parseWon("단일사업 7천만원 이상")).toBe(70_000_000);
    expect(parseWon("단일 건, 50,000천원 이상")).toBe(50_000_000);
    expect(parseWon("3억원(부가가치세 포함) 이상")).toBe(300_000_000);
    expect(parseWon("3억 5천만원 이상")).toBe(350_000_000);
    expect(parseWon("도급금액 이상")).toBeNull();
  });
});

describe("'또는'으로 이은 요건 (2026-10-02 고흥분청문화박물관 실감콘텐츠)", () => {
  const goheung = (held: CodeEntry[]) =>
    analyzeQualificationText(
      "1) 국가종합전자조달시스템 입찰 참가 자격 등록 규정에 의하여 반드시 나라장터(G2B시스템)에 입찰마감일 전일까지 " +
        "「영화 및 비디오물의 진흥에 관한 법률」 제57조에 의한 비디오물제작업[업종코드 3244] 또는 방송영상독립제작사[업종코드:3230]로 등록한 업체 " +
        "2) 정보통신공사업(0036)을 등록한 업체",
      "",
      [],
      held
    ).requirements;

  it("한쪽을 보유하면 다른 쪽은 미보유가 아니라 '다른 자격으로 충족'", () => {
    const r = goheung([{ code: "3244", name: "비디오물제작업" }, { code: "0036", name: "정보통신공사업" }]);
    const by = (code: string) => r.find((x) => x.code === code)!;
    expect(by("3244").orGroup).toBe(by("3230").orGroup);
    expect(by("3230")).toMatchObject({ held: false, covered: true });
    expect(by("0036").orGroup).toBeUndefined(); // 다른 항목(2))은 묶지 않는다
  });

  it("둘 다 없으면 둘 다 미보유", () => {
    const r = goheung([{ code: "0036", name: "정보통신공사업" }]);
    expect(r.filter((x) => x.orGroup !== undefined).every((x) => !x.held && !x.covered)).toBe(true);
  });
});
