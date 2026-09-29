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
}

const INDICATORS = /업종\s*코드|세부\s*품명|물품\s*분류\s*번호|등록|면허|소재지|직접생산/g;

/**
 * 공고문 전체에서 참가자격 부분을 고른다. "참가자격"이라는 말은 청렴 서약 문구("참가자격 제한 등의
 * 불이익") 같은 데도 나와서 첫 번째 것을 쓰면 엉뚱한 곳을 잡는다(울산과학관 공고 실측).
 * 등장 위치마다 뒤 1500자 안에 자격 관련 단어가 몇 개인지 세어 가장 많은 곳을 쓴다.
 */
export function findQualificationSection(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  let best: { at: number; score: number } | null = null;
  for (const m of flat.matchAll(/참가\s*자격/g)) {
    const window = flat.slice(m.index, m.index + 1500);
    let score = window.match(INDICATORS)?.length ?? 0;
    const head = flat.slice(m.index, m.index + 40);
    // "참가자격 가.", "참가 자격 (아래…)", "참가자격 ○" 처럼 제목 뒤에 항목이 바로 오면 본문일 가능성이 높다.
    if (/참가\s*자격\s*[:：]?\s*(\(|가\s*\.|○|①|1\)|◦|-)/.test(head)) score += 3;
    // "입찰참가자격 제한 처분" — 청렴서약·부정당업자 문구
    if (/참가\s*자격\s*(제한|이\s*없|을\s*제한|미등록)/.test(head)) score -= 5;
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
 * @param section 참가자격 부분 (코드는 여기서만 찾는다 — 다른 곳의 숫자는 공고번호·전화번호 등이라 오탐이 난다)
 * @param fullText 공고문 전체 (지역제한·지명경쟁은 "입찰방식" 항목에 따로 적히는 경우가 많아 전체에서 본다)
 */
export function analyzeQualificationText(
  section: string,
  fullText: string,
  heldProducts: CodeEntry[],
  heldIndustries: CodeEntry[]
): Omit<QualificationDocResult, "sourceFile"> {
  const industryName = new Map(heldIndustries.map((c) => [c.code, c.name]));
  const productName = new Map(heldProducts.map((c) => [c.code, c.name]));
  const requirements: DocRequirement[] = [];
  const seen = new Set<string>();
  const add = (kind: DocRequirement["kind"], code: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    const name = (kind === "업종" ? industryName : productName).get(code) ?? null;
    requirements.push({ kind, code, name, held: name !== null });
  };

  // "업종코드 4444", "[업종코드 4444]", "(업종코드: 4990)" — 코드 뒤에 "또는 4442"처럼 이어지는 것도 잡는다.
  for (const m of section.matchAll(/업종\s*코드\s*[:：]?\s*\[?\s*(\d{4})\b/g)) add("업종", m[1]!);
  // "[실내건축공사(4990)]", "정보통신공사업(0036)" — 업종명 바로 뒤 괄호 속 4자리
  for (const m of section.matchAll(/(?:업|공사|분야|사업)\s*[(（]\s*(\d{4})\s*[)）]/g)) add("업종", m[1]!);
  // "세부품명번호: 6012100201", "물품분류번호 4924159701", "(세부품명번호 1...)"
  for (const m of section.matchAll(/(?:세부\s*품명\s*번호|물품\s*분류\s*번호|분류번호\s*10자리)[^0-9]{0,20}(\d{10})\b/g)) add("품명", m[1]!);
  // 코드 없이 이름만 적은 보유 자격 (예: "전문건설업(…금속구조물·창호·온실공사업…)")
  const flat = normalize(section);
  for (const c of heldIndustries) {
    if (seen.has(c.code)) continue;
    if (flat.includes(normalize(c.name)) && !requirements.some((r) => r.name === c.name)) {
      requirements.push({ kind: "업종", code: null, name: c.name, held: true });
      seen.add(c.code);
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
  for (const attachment of pickNoticeDocAttachments(notice)) {
    const path = await downloadAttachment(attachment);
    if (!path) continue;
    try {
      const { text } = await extractDocumentText(path, { ocr: "auto", maxPages: 12 });
      const section = findQualificationSection(text);
      if (!section) continue;
      return { sourceFile: attachment.name, ...analyzeQualificationText(section, text, held.products, held.industries) };
    } catch (err) {
      logger.debug?.("공고문 참가자격 읽기 실패", { noticeNo: notice.noticeNo, file: attachment.name, error: String(err) });
    }
  }
  return null;
}
