import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { pickQuantityAttachments, pickSpecAttachments } from "../src/api/attachments.js";
import { noticeOutline, quantityItems } from "../src/api/noticeOutline.js";
import { linkedPreStandardNo, specUrlsOf } from "../src/api/linkedPreStandard.js";
import { detectFormat, extractDocumentText } from "../src/corpus/extractText.js";
import { workVocabulary } from "../src/similarity/keywordEvidence.js";
import { extractWorkTerms, keywordCosine } from "../src/similarity/keywordScore.js";
import { SimilarityIndex } from "../src/similarity/index.js";
import type { NormalizedNotice } from "../src/api/types.js";

const tmp = mkdtempSync(join(tmpdir(), "outline-"));

function noticeWith(files: string[], raw: Record<string, string> = {}): NormalizedNotice {
  files.forEach((name, i) => {
    raw[`ntceSpecFileNm${i + 1}`] = name;
    raw[`ntceSpecDocUrl${i + 1}`] = `https://example.invalid/${i + 1}`;
  });
  return { noticeNo: "T", title: "t", businessType: "공사", sourceType: "본공고", raw } as unknown as NormalizedNotice;
}

describe("워드·엑셀 첨부 읽기", () => {
  it("docx 본문을 문단 단위로 읽는다 (서당골천 조형물 시방서.docx 같은 경우)", async () => {
    const path = join(tmp, "시방서.docx");
    const xml = `<w:document><w:body><w:p><w:r><w:t>1. 조형물 제작</w:t></w:r></w:p><w:p><w:r><w:t>스테인리스 &amp; 도장</w:t></w:r></w:p></w:body></w:document>`;
    writeFileSync(path, zipSync({ "word/document.xml": strToU8(xml), "[Content_Types].xml": strToU8("<Types/>") }));
    expect(detectFormat(path)).toBe("docx");
    const r = await extractDocumentText(path);
    expect(r.text).toContain("1. 조형물 제작\n스테인리스 & 도장");
  });

  it("xlsx는 글자 칸만 (숫자·단위 칸은 뺀다)", async () => {
    const path = join(tmp, "공내역서.xlsx");
    const xml = `<sst><si><t>전시실 진열장 및 전시구조물</t></si><si><t>EA</t></si><si><r><t>그래픽 </t></r><r><t>패널</t></r></si><si><t>123</t></si></sst>`;
    writeFileSync(path, zipSync({ "xl/sharedStrings.xml": strToU8(xml), "xl/workbook.xml": strToU8("<workbook/>") }));
    expect(detectFormat(path)).toBe("xlsx");
    const r = await extractDocumentText(path);
    expect(r.text.split("\n")).toEqual(["전시실 진열장 및 전시구조물", "그래픽 패널"]);
  });

  it("엑셀은 과업 문서 후보가 아니라 내역서 후보로만 고른다", () => {
    const n = noticeWith(["공고문.hwpx", "규격서.xlsx", "공내역서.xlsx", "산출내역서.xlsx", "공내역서(화장실).zip", "시방서.docx"]);
    expect(pickSpecAttachments(n).map((a) => a.name)).toEqual(["시방서.docx"]);
    expect(pickQuantityAttachments(n).map((a) => a.name)).toEqual(["공내역서.xlsx", "공내역서(화장실).zip"]);
  });
});

describe("공고문 개요·내역서 품명", () => {
  it("공고문에서 공사명·공사개요 같은 개요 줄만, '붙임파일 참조'·'1식'은 뺀다", () => {
    const text = [
      "1. 공사개요",
      "1.2. 공 사 명 : ○○박물관 1전시실 리모델링 공사",
      "1.3. 공사현장 : ○○시 ○○로 13",
      "라. 공사개요 : 인테리어공사 1식",
      "1.5.1. 공사내용: 붙임파일 참조",
      "주요내용 : 전시실 진열장 교체 및 그래픽 제작 설치",
      "2. 입찰참가자격 …",
    ].join("\n");
    expect(noticeOutline(text).split("\n")).toEqual(["○○박물관 1전시실 리모델링 공사", "인테리어공사 1식", "전시실 진열장 교체 및 그래픽 제작 설치"]);
  });

  it("내역서에서 공종코드·수식·간접비·표 머리·규격은 빼고 품명만 (2026-10-13 실측 모양)", () => {
    const text = [
      "ZZB300100000", "직접노무비* 3.595%", "(AZZ+BZZ)*%%", "국민 건강 보험료", "하도급지급보증수수료", "단위", "JUK15",
      "5232620562982060BDEA7659EC2FCB", "높이 2m, 3개월", "호표 1",
      "전시실 진열장 및 전시구조물", "1층 독립진열장", "0102 도장공사", "그래픽 디자인 및 제작 설치 포함",
    ].join("\n");
    expect(quantityItems(text)).toEqual(["전시실 진열장 및 전시구조물", "1층 독립진열장", "도장공사", "그래픽 디자인 및 제작 설치 포함"]);
  });
});

describe("연결 사전규격", () => {
  it("본공고의 bfSpecRgstNo만 쓴다 (사전규격 자신이나 빈 값은 아님)", () => {
    expect(linkedPreStandardNo(noticeWith([], { bfSpecRgstNo: "R26BD00264040" }))).toBe("R26BD00264040");
    expect(linkedPreStandardNo(noticeWith([], { bfSpecRgstNo: "" }))).toBeNull();
    const pre = { ...noticeWith([], { bfSpecRgstNo: "R26BD00264040" }), sourceType: "사전규격" } as NormalizedNotice;
    expect(linkedPreStandardNo(pre)).toBeNull();
  });

  it("사전규격 응답에서 비어 있지 않은 첨부 URL만", () => {
    expect(specUrlsOf({ specDocFileUrl1: "https://a/1", specDocFileUrl2: "", specDocFileUrl3: " https://a/3 " })).toEqual(["https://a/1", "https://a/3"]);
  });
});

describe("싱크로율 — 실적 키워드 점수", () => {
  const vocabulary = workVocabulary(["과학관", "체험관"]);
  const set = (...terms: string[]) => new Map(terms.map((t) => [t, 1]));

  it("지역·기관명이 아니라 일의 종류를 말하는 말만 뽑는다 ('제작 및 설치'도 제작설치로)", () => {
    const terms = extractWorkTerms("국립부산과학관 4D 체험관 영상콘텐츠 제작 및 설치, 전시실 개선", vocabulary);
    expect([...terms.keys()]).toEqual(expect.arrayContaining(["과학관", "체험관", "영상콘텐츠", "제작설치", "전시실"]));
    expect([...terms.keys()].some((t) => t.includes("부산"))).toBe(false);
  });

  it("긴 말 안의 짧은 말은 따로 세지 않는다 — 따로 나온 것만 센다", () => {
    const terms = extractWorkTerms("상징조형물 제작, 상징 조형물 설치, 조형물 보수", vocabulary);
    expect(terms.get("상징조형물")).toBe(2);
    expect(terms.get("조형물")).toBe(1);
    expect(extractWorkTerms("상징조형물 제작", vocabulary).has("조형물")).toBe(false);
  });

  it("시설 이름 하나만 겹치면 점수가 낮다 — 사업명뿐인 과거 실적이 만점을 받던 문제 (2026-10-13)", () => {
    const facilityOnly = keywordCosine(set("과학관"), set("과학관"));
    const contentShared = keywordCosine(set("전시물", "실물모형", "디오라마"), set("전시물", "실물모형", "디오라마", "과학관"));
    expect(facilityOnly.score).toBeLessThan(0.1);
    expect(contentShared.score).toBeGreaterThan(0.5);
    expect([...contentShared.shared].sort()).toEqual(["디오라마", "실물모형", "전시물"].sort());
  });

  it("함께 나온 말은 점수에 많이 보탠 것부터 — 일의 내용이 시설 이름보다 앞", () => {
    expect(keywordCosine(set("박물관", "전시물"), set("박물관", "전시물")).shared).toEqual(["전시물", "박물관"]);
  });

  it("어휘를 주면 점수 80%가 키워드, 근거 키워드가 결과에 실린다", () => {
    const projects = [
      { id: "a", year: 2025, folderName: "a", name: "○○과학관 전시물 제작설치", officialName: null, body: "실물모형 전시물 제작 설치", budgetAmount: null, sourceFiles: [] },
      { id: "b", year: 2025, folderName: "b", name: "○○과학관 주차장 정비", officialName: null, body: "", budgetAmount: null, sourceFiles: [] },
    ];
    const index = SimilarityIndex.build(projects, { keywordVocabulary: vocabulary });
    const r = index.findSimilar("△△과학관 전시물 제작·설치", 2, { keywordText: "실물모형" });
    expect(r.top[0]!.id).toBe("a");
    expect(r.top[0]!.keywords).toEqual(expect.arrayContaining(["전시물", "실물모형", "제작설치"]));
    expect(r.top[0]!.keywordScore).toBeGreaterThan(0);
    // 어휘 없이 만든 인덱스는 예전과 같다
    expect(SimilarityIndex.build(projects).findSimilar("△△과학관 전시물 제작·설치").top[0]!.keywordScore).toBeNull();
  });

  it("과거 실적 키워드는 12,000자 본문이 아니라 fullBody(앞 20,000자)에서 센다", () => {
    const filler = "가".repeat(15_000);
    const projects = [
      { id: "a", year: 2025, folderName: "a", name: "○○ 사업", officialName: null, body: filler.slice(0, 12_000), fullBody: `${filler} 디오라마 제작`, budgetAmount: null, sourceFiles: [] },
    ];
    const index = SimilarityIndex.build(projects, { keywordVocabulary: vocabulary });
    expect(index.findSimilar("디오라마 제작", 1, { body: "디오라마" }).top[0]?.keywords).toContain("디오라마");
  });
});
