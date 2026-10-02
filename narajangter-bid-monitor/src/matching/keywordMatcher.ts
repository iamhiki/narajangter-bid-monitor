import type { NormalizedNotice } from "../api/types.js";

/**
 * 공고 제목 표기가 "운영 용역"/"운영용역"처럼 공백 유무만 다른 경우가 많아,
 * 매칭 전 공백을 모두 제거해 비교한다 (keywords.json 쪽 등록 문구는 공백을 넣어도/빼도 무방).
 */
function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * 공고 제목(및 품목명)에 키워드가 포함되는지 확인한다.
 * 참고: data.go.kr API는 공고 "과업내용" 상세(첨부파일)까지는 제공하지 않으므로
 * 제목/품목명 텍스트를 기준으로 매칭한다 (README 참고).
 */
export function matchKeywords(notice: NormalizedNotice, keywords: string[]): string[] {
  const haystack = stripWhitespace(`${notice.title} ${notice.productClsfcName ?? ""}`);
  const matched: string[] = [];
  for (const keyword of keywords) {
    if (haystack.includes(stripWhitespace(keyword))) {
      matched.push(keyword);
    }
  }
  return matched;
}

/**
 * 제목에 제외 키워드가 포함되면 코드/키워드가 매칭되어도 결과에서 뺀다.
 * 일반 구매/정비/공사처럼 코드·업종상으로는 걸리지만 실제로는 전시업과 무관한 공고를 걸러내기 위함.
 */
export interface ExcludeRules {
  /** 제외하되 제작 신호가 있으면 통과시키는 넓은 단어 (연출·구매·정비 등) */
  softExcludeKeywords?: string[];
  /** "제작·설치", "제조구매" 같은 제작 발주 신호. 가운뎃점·공백은 무시하고 본다 */
  makeSignals?: string[];
  /** 제외 키워드별로, 이 말 안에 들어 있는 경우는 무시 ("건축" → "실내건축") */
  excludeKeywordExceptions?: Record<string, string[]>;
}

/**
 * 제작 신호 비교용 — "제작·설치", "제작 설치", "제작‧설치"를 같게 본다.
 * 실측 표기: 공고 제목에 "제작.설치"·"제작/설치"·"제작˙설치"·"제작,설치", 과거 실적(한글 문서)에
 * "제작․설치"(U+2024)·사용자 정의 공백(U+F0A0)이 있다.
 */
const stripSeparators = (value: string): string => value.replace(/[\s·‧ㆍ∙・•․˙.,/]+/g, "");

export function matchExcludeKeyword(notice: NormalizedNotice, excludeKeywords: string[], rules: ExcludeRules = {}): string | null {
  const title = stripWhitespace(notice.title);
  const hit = (keyword: string): boolean => {
    let haystack = title;
    for (const ex of rules.excludeKeywordExceptions?.[keyword] ?? []) haystack = haystack.split(stripWhitespace(ex)).join("|");
    return haystack.includes(stripWhitespace(keyword));
  };
  for (const keyword of excludeKeywords) {
    if (hit(keyword)) return keyword;
  }
  const soft = rules.softExcludeKeywords ?? [];
  if (soft.length === 0) return null;
  const plain = stripSeparators(notice.title);
  const hasMakeSignal = (rules.makeSignals ?? []).some((s) => plain.includes(stripSeparators(s)));
  if (hasMakeSignal) return null;
  for (const keyword of soft) {
    if (hit(keyword)) return keyword;
  }
  return null;
}
