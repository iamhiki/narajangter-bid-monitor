import type { CodeEntry } from "../config/loadJsonConfig.js";
import type { NormalizedNotice } from "../api/types.js";
import { downloadAttachment, listAttachments, type NoticeAttachment } from "../api/attachments.js";
import { extractDocumentText } from "../corpus/extractText.js";
import { logger } from "../logger.js";

/**
 * 입찰공고문 첨부에서 참가자격을 읽는다.
 *
 * 면허제한정보 API에 공고가 아예 없으면 화면에 "업종제한 없음"으로 나오는데, 실제 공고문을
 * 열어보면 업종코드·세부품명번호·지역제한이 적혀 있는 경우가 많다(2026-09-29 실측 4건 중 4건).
 * API에 없는 제한도 있다:
 *   - 지역제한: "본점소재지가 경상북도에 있는 업체" (유교랜드 조합놀이대)
 *   - 조합추천 지명경쟁: "아래의 8개 업체이어야 합니다" (순창 전시홍보관 — 지일은 명단에 없음)
 *
 * **판정이 아니라 발췌다.** 공고문 문장은 "A 또는 B", "모두 충족" 같은 조건 구조가 제각각이라
 * 기계적으로 참가 가능 여부를 단정하지 않는다. 문서에서 찾은 코드마다 보유 여부를 표시하고
 * 경고(지역·지명)를 띄워 사람이 빨리 판단하게 돕는다.
 */

export interface DocRequirement {
  kind: "업종" | "품명";
  code: string | null;
  /** 보유 자격 목록에서 찾은 이름. 미보유 코드는 null */
  name: string | null;
  held: boolean;
  /** 공고문에 코드와 함께 적힌 이름 (예: "교육훈련장비"). 못 찾으면 null */
  docName: string | null;
  /**
   * 미보유 세부품명번호일 때, 같은 분류 계층에 있는 지일 보유 품목.
   * 세부품명번호 10자리 = 물품분류번호 8자리(대·중·소분류·품명 각 2자리) + 세부 2자리라서
   * 앞자리가 같을수록 가까운 품목이다. 등록은 세부품명 단위라 "보유"는 아니지만, 추가 등록이나
   * 유사 품목 판단에 참고가 된다.
   */
  related: { level: "같은 품명" | "같은 소분류" | "같은 중분류"; items: { code: string; name: string }[] } | null;
  /**
   * 공고문이 이 코드를 어떤 요건으로 걸었는지. 미보유일 때 해결 난이도가 전혀 다르다.
   *   등록     — "…(세부품명번호: 6010999901)로 등록한 업체": 나라장터 입찰참가자격 등록에 세부품명을
   *              추가하면 된다. 등록 마감(bidQlfctRgstDt) 전까지 가능.
   *   직접생산 — "직접생산확인증명서[… 세부품명번호 …]": 중소기업 공공구매 종합정보망(SMPP) 신청과
   *              현장 실사가 필요해 공고 기간 안에 갖추기 어렵다.
   *   면허     — 업종코드(건설업·산업디자인 등 법령상 등록·면허). 단기간 취득 불가.
   * 같은 코드가 여러 요건으로 나오면(등록 + 직접생산) 전부 담는다.
   */
  bases: RequirementBasis[];
}

export type RequirementBasis = "등록" | "직접생산" | "면허";

/**
 * 코드가 나온 문장에서 요건 종류를 읽는다. 앞쪽은 가장 가까운 항목 기호(1), 가., ○, ※)나 문장 끝("다.")
 * 이후만 본다 — 앞 항목의 "직접생산확인증명서"가 다음 항목 코드에 붙으면 오판한다.
 */
export function requirementBasis(section: string, at: number, kind: DocRequirement["kind"]): RequirementBasis {
  if (kind === "업종") return "면허";
  const raw = section.slice(Math.max(0, at - 160), at);
  const boundary = [...raw.matchAll(/(?:\d+\)|[가-하]\s?\.(?!\d)|[○◦※]|다\s?\.)/g)].pop();
  const before = boundary ? raw.slice(boundary.index! + boundary[0].length) : raw;
  return /직\s*접\s*생\s*산/.test(before) ? "직접생산" : "등록";
}

const CLASS_LEVELS = [
  { digits: 8, level: "같은 품명" },
  { digits: 6, level: "같은 소분류" },
  { digits: 4, level: "같은 중분류" },
] as const;

/** 미보유 세부품명번호와 가장 가까운 계층의 보유 품목 (없으면 null) */
export function relatedHeldProducts(code: string, heldProducts: CodeEntry[]): DocRequirement["related"] {
  for (const { digits, level } of CLASS_LEVELS) {
    const items = heldProducts.filter((p) => p.code !== code && p.code.slice(0, digits) === code.slice(0, digits));
    if (items.length) return { level, items: items.map((p) => ({ code: p.code, name: p.name })) };
  }
  return null;
}

/**
 * 코드 주변에서 공고문이 적어 둔 이름을 찾는다. 실측 표기:
 *   "교 육훈련장비(세부품명번호: 6010999901)"          — 이름이 앞, 괄호 안에 번호 (HWP 추출 시 글자 사이 공백)
 *   "[세부품명: 조형물, 세부품명번호: 6012100201"       — "세부품명:" 라벨
 *   "[물품분류번호 4924159701 : 조합놀이대]"            — 번호 뒤 콜론
 *   "(안내전광판, 물품분류번호: 5512190301)"            — 괄호 안 쉼표
 *   "조합놀이대 (세부품명번호 4924159701)"
 *   "종합디자인분야 [업종코드 4444]", "비디오제작업 (업종코드: 3244)"
 */
export function nameNearCode(section: string, index: number, length: number): string | null {
  const before = section.slice(Math.max(0, index - 60), index);
  const after = section.slice(index + length, index + length + 40);
  const clean = (s: string | undefined) => {
    const v = (s ?? "").replace(/\s+/g, "").replace(/^(G2B)?(물품)?(분류번호|세부품명|품명|업종명?)[:：]?/, "");
    return v.length >= 2 && v.length <= 30 && /[가-힣]/.test(v) ? v : null;
  };
  const label = String.raw`(?:세부\s*품\s*명\s*번\s*호|물\s*품\s*분\s*류\s*번\s*호|업\s*종\s*코\s*드|분류번호\s*10자리)`;

  // 번호 뒤 콜론: "4924159701 : 조합놀이대]"
  const a = /^\s*[:：]\s*([가-힣A-Za-z·ㆍ\s]{2,30}?)\s*[\])）,]/.exec(after);
  if (a) return clean(a[1]);
  // "세부품명: 조형물, 세부품명번호: " — 바로 앞 라벨
  const b = new RegExp(String.raw`세부\s*품\s*명\s*[:：]\s*([^,\]\)]{2,30}?)\s*,?\s*${label}[^0-9]{0,6}$`).exec(before);
  if (b) return clean(b[1]);
  // "(안내전광판, 물품분류번호: "
  const c = new RegExp(String.raw`[\(（\[]\s*([^,()\[\]]{2,30}?)\s*,\s*${label}[^0-9]{0,6}$`).exec(before);
  if (c) return clean(c[1]);
  // "교육훈련장비(세부품명번호: ", "종합디자인분야 [업종코드 " — 이름 뒤 여는 괄호
  const d = new RegExp(String.raw`([가-힣·ㆍ][가-힣·ㆍ\s]{1,24}?)\s*[\(（\[]\s*${label}[^0-9]{0,6}$`).exec(before);
  if (d) {
    // 앞쪽에 설명어가 붙어 오면 마지막 덩어리만 남긴다:
    //   "G2B분류번호 교 육훈련장비", "10자리 조합놀이대", "전문회사로 종합디자인분야", "또는 환경디자인분야"
    // 공백으로 자르면 안 된다 — HWP 추출은 "교 육훈련장비"처럼 단어 중간에 공백을 넣는다.
    // "및"은 띄어 쓴 경우만 연결어로 본다 — "전시부스설치및디자인서비스"처럼 이름 안에도 들어간다
    const words = d[1]!.split(/번호|분류|등록|의한|따른|자리|또는|\s및\s|(?:로서|으로|로)\s/);
    return clean(words[words.length - 1]);
  }
  return null;
}

export interface QualificationDocResult {
  sourceFile: string;
  /** 참가자격 부분 발췌 (공백 정리, 최대 1200자) */
  excerpt: string;
  requirements: DocRequirement[];
  /** 지역제한 문구 (예: "경상북도") */
  region: string | null;
  /** 지명경쟁·조합추천처럼 명단에 있는 업체만 참가 가능한 공고 */
  designated: boolean;
  /** 지명 명단에 지일이 있는지 (designated일 때만 의미) */
  jiilDesignated: boolean;
  /** 입찰참가자격 등록 마감 (API bidQlfctRgstDt). 미보유 품목을 추가 등록할 수 있는 기한 */
  registrationDeadline: string | null;
  /** 공고가 분류된 세부품명 (사전규격 prdctDtlList, 본공고 dtilPrdctClsfcNo) 과 지일 보유 여부 */
  classifiedItems: { code: string; name: string; held: boolean }[];
  /** 사전규격에 연결된 본공고 번호 (본공고가 이미 나왔으면) */
  linkedBidNo: string | null;
  /** 첨부에서 참가자격 항목을 찾았는지. false면 requirements·지역·지명은 비어 있고 분류 품목만 있다 */
  sectionFound: boolean;
}

const INDICATORS = /업종\s*코드|세부\s*품명|물품\s*분류\s*번호|등록|면허|소재지|직접생산/g;

/**
 * 코드 없이 법령 이름으로만 거는 면허 중 지일이 없는 것. 설계공모는 업종코드 대신
 * "「건축사법」 제7조에 따른 건축사 면허 … 건축사사무소를 개설하고 있는 자"라고만 쓴다.
 * 참가자격 앞부분(첫 항목)에서만 본다 — 뒤쪽에는 "당선자가 전기·소방 설계 자격이 없으면 공동수급"
 * 같은 부수 조건이 섞여 있어 그것까지 요건으로 잡으면 오탐이다.
 */
const NAMED_LICENSES: { pattern: RegExp; name: string }[] = [
  { pattern: /건\s*축\s*사\s*(면허|사무소)|「\s*건\s*축\s*사\s*법\s*」/, name: "건축사사무소 개설(건축사법)" },
  { pattern: /엔지니어링\s*사업자/, name: "엔지니어링사업자" },
  { pattern: /(문화재|국가유산)\s*수리\s*업/, name: "문화재수리업" },
];
const NAMED_LICENSE_SPAN = 400;

/**
 * 공고문 전체에서 참가자격 부분을 고른다. "참가자격"이라는 말은 청렴 서약 문구("참가자격 제한 등의
 * 불이익") 같은 데도 나와서 첫 번째 것을 쓰면 엉뚱한 곳을 잡는다(울산과학관 공고 실측).
 * 등장 위치마다 뒤 1500자 안에 자격 관련 단어가 몇 개인지 세어 가장 많은 곳을 쓴다.
 */
export function findQualificationSection(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  let best: { at: number; score: number } | null = null;
  // 설계공모는 "설계 공모 참가자의 자격", "응모자격"으로 쓴다 (거제 지심도 제안공모 실측)
  for (const m of flat.matchAll(/참가\s*자\s*의\s*자격|참가\s*자격|응모\s*자격/g)) {
    const window = flat.slice(m.index, m.index + 1500);
    let score = window.match(INDICATORS)?.length ?? 0;
    const head = flat.slice(m.index, m.index + 40);
    const after = head.slice(m[0].length);
    // "참가자격 가.", "참가 자격 (아래…)", "참가자격 ○" 처럼 제목 뒤에 항목이 바로 오면 본문일 가능성이 높다.
    if (/^\s*[:：]?\s*(\(|가\s*\.|○|①|1\)|◦|-)/.test(after)) score += 3;
    // "입찰참가자격 제한 처분" — 청렴서약·부정당업자 문구, "참가자격은 박탈된다" — 중복응모 벌칙
    if (/^\s*(은|을|이)?\s*(제한|없|미등록|박탈|갖추지)/.test(after)) score -= 5;
    if (!best || score > best.score) best = { at: m.index, score };
  }
  if (!best || best.score < 2) return null;
  return flat.slice(best.at, best.at + 1500);
}

const REGIONS =
  "서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|강원도|충청북도|충청남도|전북특별자치도|전라북도|전라남도|경상북도|경상남도|제주특별자치도|" +
  "서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주";
/**
 * "본점 소재지(…)가 [충청남도] 또는 [세종특별시]에 있는 업체" — 괄호 설명이 끼어들어 80자까지 본다.
 * 납품장소·공사현장 주소에도 지명이 나오므로 "소재지"와 "있는/소재한/업체"로 앞뒤를 묶는다.
 */
const REGION_PATTERN = new RegExp(`소재지[^.]{0,80}?(${REGIONS})[^.]{0,40}?(있는|소재한|소재하는|업체)`);

const normalize = (s: string): string => s.replace(/[\s·ㆍ.,()（）]/g, "");

/**
 * 업종 이름이 면허 요건으로 나왔는지. 바로 뒤에 "법"이 붙은 건 법령 이름이라 뺀다 —
 * 「정보통신공사업법」에 따른 용역업자와 공동도급 같은 문구가 정보통신공사업 보유로 잡혔다(거제 지심도 실측).
 */
function mentionsLicense(flat: string, name: string): boolean {
  for (let at = flat.indexOf(name); at >= 0; at = flat.indexOf(name, at + 1)) {
    if (flat[at + name.length] !== "법") return true;
  }
  return false;
}

/**
 * @param section 참가자격 부분 (코드는 여기서만 찾는다 — 다른 곳의 숫자는 공고번호·전화번호 등이라 오탐이 난다)
 * @param fullText 공고문 전체 (지역제한·지명경쟁은 "입찰방식" 항목에 따로 적히는 경우가 많아 전체에서 본다)
 */
export function analyzeQualificationText(
  section: string,
  fullText: string,
  heldProducts: CodeEntry[],
  heldIndustries: CodeEntry[]
): Omit<QualificationDocResult, "sourceFile" | "registrationDeadline" | "classifiedItems" | "linkedBidNo" | "sectionFound"> {
  const industryName = new Map(heldIndustries.map((c) => [c.code, c.name]));
  const productName = new Map(heldProducts.map((c) => [c.code, c.name]));
  const requirements: DocRequirement[] = [];
  const seen = new Set<string>();
  const add = (kind: DocRequirement["kind"], m: RegExpMatchArray) => {
    const code = m[1]!;
    const at = m.index! + m[0].lastIndexOf(code);
    const docName = nameNearCode(section, at, code.length);
    const existing = requirements.find((r) => r.code === code);
    if (existing) {
      // 같은 코드가 여러 번 나오면 이름이 적힌 쪽을 쓴다 (첫 등장에 이름이 없을 수 있다)
      existing.docName ??= docName;
      const basis = requirementBasis(section, at, kind);
      if (!existing.bases.includes(basis)) existing.bases.push(basis);
      return;
    }
    seen.add(code);
    const name = (kind === "업종" ? industryName : productName).get(code) ?? null;
    const related = kind === "품명" && name === null ? relatedHeldProducts(code, heldProducts) : null;
    requirements.push({ kind, code, name, held: name !== null, docName, related, bases: [requirementBasis(section, at, kind)] });
  };

  // "업종코드 4444", "[업종코드 4444]", "(업종코드: 4990)" — 코드 뒤에 "또는 4442"처럼 이어지는 것도 잡는다.
  for (const m of section.matchAll(/업종\s*코드\s*[:：]?\s*\[?\s*(\d{4})\b/g)) add("업종", m);
  // "[실내건축공사(4990)]", "정보통신공사업(0036)" — 업종명 바로 뒤 괄호 속 4자리
  for (const m of section.matchAll(/(?:업|공사|분야|사업)\s*[(（]\s*(\d{4})\s*[)）]/g)) add("업종", m);
  // "세부품명번호: 6012100201", "물품분류번호 4924159701", "(세부품명번호 1...)"
  for (const m of section.matchAll(/(?:세부\s*품명\s*번호|물품\s*분류\s*번호|분류번호\s*10자리)[^0-9]{0,20}(\d{10})\b/g)) add("품명", m);
  // 코드 없이 이름만 적은 보유 자격 (예: "전문건설업(…금속구조물·창호·온실공사업…)")
  const flat = normalize(section);
  for (const c of heldIndustries) {
    if (seen.has(c.code)) continue;
    if (mentionsLicense(flat, normalize(c.name)) && !requirements.some((r) => r.name === c.name)) {
      requirements.push({ kind: "업종", code: null, name: c.name, held: true, docName: null, related: null, bases: ["면허"] });
      seen.add(c.code);
    }
  }
  const head = section.slice(0, NAMED_LICENSE_SPAN);
  for (const l of NAMED_LICENSES) {
    if (l.pattern.test(head)) {
      requirements.push({ kind: "업종", code: null, name: null, held: false, docName: l.name, related: null, bases: ["면허"] });
    }
  }

  const whole = fullText.replace(/\s+/g, " ");
  const region = REGION_PATTERN.exec(whole)?.[1] ?? null;
  const designated = /지명\s*경쟁\s*입찰|조합\s*추천|추천\s*받은|아래의?\s*\d+\s*개\s*업체/.test(whole);
  const jiilDesignated = designated && /지일/.test(whole);

  return {
    excerpt: section.slice(0, 1200),
    requirements,
    region,
    designated,
    jiilDesignated,
  };
}

/** 입찰공고문으로 보이는 첨부를 우선순위대로. HWPX가 HWP·PDF보다 추출이 깨끗하다. */
export function pickNoticeDocAttachments(notice: NormalizedNotice): NoticeAttachment[] {
  if (notice.sourceType === "사전규격") return preStandardAttachments(notice);
  const all = listAttachments(notice);
  const isNoticeDoc = (a: NoticeAttachment) => /공고/.test(a.name) && !/제안요청|과업|시방|규격/.test(a.name);
  const extRank = (name: string) => (/\.hwpx$/i.test(name) ? 0 : /\.pdf$/i.test(name) ? 1 : 2);
  return all.filter(isNoticeDoc).sort((a, b) => extRank(a.name) - extRank(b.name));
}

/**
 * 공고 하나의 공고문을 받아 참가자격을 읽는다. 공고문이 없거나 참가자격 부분을 못 찾으면 null.
 * 스캔 PDF를 대비해 OCR은 "auto"(텍스트 없는 쪽만) — Windows 로컬 UI에서만 쓰는 경로다.
 */
export async function readQualificationFromNotice(
  notice: NormalizedNotice,
  held: { products: CodeEntry[]; industries: CodeEntry[] }
): Promise<QualificationDocResult | null> {
  const raw = (notice.raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : null);
  const heldProductName = new Map(held.products.map((c) => [c.code, c.name]));
  const classifiedItems = classifiedItemsOf(notice).map((i) => ({ ...i, held: heldProductName.has(i.code) }));
  const linkedBidNo = str("bidNtceNoList")?.split(/[,\s]+/)[0] ?? null;
  const common = { registrationDeadline: str("bidQlfctRgstDt"), classifiedItems, linkedBidNo };

  for (const attachment of pickNoticeDocAttachments(notice)) {
    const path = await downloadAttachment(attachment);
    if (!path) continue;
    try {
      const { text } = await extractDocumentText(path, { ocr: "auto", maxPages: 12 });
      const section = findQualificationSection(text);
      if (!section) continue;
      return {
        sourceFile: attachment.name,
        ...analyzeQualificationText(section, text, held.products, held.industries),
        ...common,
        sectionFound: true,
      };
    } catch (err) {
      logger.debug?.("공고문 참가자격 읽기 실패", { noticeNo: notice.noticeNo, file: attachment.name, error: String(err) });
    }
  }
  // 참가자격 항목은 못 찾았어도 공고가 분류된 세부품명·연결된 본공고는 알려줄 수 있다.
  if (classifiedItems.length || linkedBidNo) {
    return {
      sourceFile: "",
      excerpt: "",
      requirements: [],
      region: null,
      designated: false,
      jiilDesignated: false,
      ...common,
      sectionFound: false,
    };
  }
  return null;
}

/**
 * 사전규격 첨부. 본공고와 달리 파일명 필드가 없고 URL(specDocFileUrl1~N)만 온다. 형식은 내려받은
 * 파일의 앞 바이트로 판별하므로(extractText.detectFormat) 이름이 없어도 읽힌다.
 * 실측(2026-09-29): 매칭된 사전규격 9건 중 8건의 첨부(규격서·제안요청서)에 참가자격 항목이 있었다.
 */
export function preStandardAttachments(notice: NormalizedNotice): NoticeAttachment[] {
  const raw = (notice.raw ?? {}) as Record<string, unknown>;
  const out: NoticeAttachment[] = [];
  for (let i = 1; i <= 10; i++) {
    const url = String(raw[`specDocFileUrl${i}`] ?? "").trim();
    if (url) out.push({ name: `사전규격 첨부 ${i}`, url, isSpec: true });
  }
  return out;
}

/**
 * 공고가 분류된 세부품명. 사전규격은 prdctDtlList("[1^6010989901^실물모형및전시물]" 여러 개),
 * 본공고(물품)는 dtilPrdctClsfcNo/dtilPrdctClsfcNoNm에 온다. 참가자격 문구가 없어도
 * "이 공고는 어떤 품목으로 발주되는가"를 알려준다.
 */
export function classifiedItemsOf(notice: NormalizedNotice): { code: string; name: string }[] {
  const raw = (notice.raw ?? {}) as Record<string, unknown>;
  const items: { code: string; name: string }[] = [];
  for (const m of String(raw.prdctDtlList ?? "").matchAll(/\[\s*\d+\^(\d{10})\^([^\]]+)\]/g)) {
    items.push({ code: m[1]!, name: m[2]!.trim() });
  }
  const code = String(raw.dtilPrdctClsfcNo ?? "").trim();
  if (/^\d{10}$/.test(code) && !items.some((i) => i.code === code)) {
    items.push({ code, name: String(raw.dtilPrdctClsfcNoNm ?? "").trim() || code });
  }
  return items;
}
