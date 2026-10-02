/**
 * 싱크로율 근거 — 과업 본문 쪽. 공고 과업지시서와 과거 사업 과업지시서에 **지일 핵심 키워드**가 함께 나오는지,
 * 나온다면 각각 어떤 문장에서 나오는지(앞뒤 문맥)를 보여준다.
 *
 * 점수 자체는 글자 조각(n-gram) TF-IDF로 매기는데, 겹친 조각을 그대로 모아 보여주면 "평가위원회", "가격제안서"
 * 같은 입찰 서류 공통 문구나 문맥과 상관없는 글자가 섞여 근거로 쓸 수 없었다(2026-10-01 사용자 지적).
 * 그래서 화면 근거는 핵심 키워드로 한정한다. 문맥(문장)은 검수·디버깅용으로 함께 돌려주지만 화면에는 키워드만
 * 보인다 — 줄글을 늘어놓으면 아무도 읽지 않는다(같은 날 사용자 지적).
 */

/** 등록 키워드(config/keywords.json) 외에 지일 본업을 뜻하는 말 — 과업 본문에서 근거로 볼 말 */
export const CORE_CONTENT_TERMS = [
  "전시물", "전시연출", "전시공간", "전시콘텐츠", "체험물", "실물모형", "모형", "디오라마", "전시품",
  "상설전시", "전시실", "전시설계", "체험시설", "체험전시", "조형물", "상징조형물", "포토존",
  "미디어아트", "미디어월", "미디어파사드", "실감콘텐츠", "실감형", "인터랙티브", "프로젝션", "영상콘텐츠",
  "그래픽", "키오스크", "진열장", "놀이시설", "놀이터", "놀이기구", "공간연출", "전시디자인",
];

export interface KeywordEvidence {
  keyword: string;
  /** 공고 과업 본문에서 이 말이 나온 횟수와 대표 문맥 */
  noticeCount: number;
  noticeContext: string;
  /** 과거 사업 과업 본문에서 */
  pastCount: number;
  pastContext: string;
}

/** "제작·설치", "전시 물"처럼 띄어쓰기·가운뎃점이 끼어도 찾는다 */
function termPattern(term: string): RegExp {
  const chars = [...term.replace(/[\s·ㆍ‧∙・․]+/g, "")].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(chars.join("[\\s·ㆍ‧∙・․]*"), "g");
}

/** 일치 위치 앞뒤로 잘라 한 줄 문맥을 만든다 */
function contextAround(text: string, index: number, length: number, radius = 28): string {
  const from = Math.max(0, index - radius);
  const to = Math.min(text.length, index + length + radius);
  const snippet = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${snippet}${to < text.length ? "…" : ""}`;
}

/**
 * 두 문서에 함께 나오는 핵심 키워드. 양쪽 등장 횟수가 고르게 많은 것부터(min), 같으면 긴 말부터.
 * 긴 말("상징조형물")에 포함된 짧은 말("조형물")은 긴 말이 잡혔으면 뺀다.
 * 문맥은 각 문서에서 처음 나온 곳 — 목차·표지에 걸린 것을 피하려고 가능하면 두 번째 등장(본문)을 쓴다.
 */
export function keywordEvidence(noticeText: string, pastText: string, vocabulary: string[], limit = 4): KeywordEvidence[] {
  if (!noticeText || !pastText) return [];
  const terms = [...new Set(vocabulary.map((t) => t.replace(/[\s·ㆍ‧∙・․]+/g, "")).filter((t) => t.length >= 2))];
  const found: KeywordEvidence[] = [];
  for (const term of terms) {
    const inNotice = [...noticeText.matchAll(termPattern(term))];
    if (inNotice.length === 0) continue;
    const inPast = [...pastText.matchAll(termPattern(term))];
    if (inPast.length === 0) continue;
    const pick = (ms: RegExpMatchArray[]) => ms[ms.length > 1 ? 1 : 0]!;
    const n = pick(inNotice);
    const p = pick(inPast);
    found.push({
      keyword: term,
      noticeCount: inNotice.length,
      noticeContext: contextAround(noticeText, n.index!, n[0].length),
      pastCount: inPast.length,
      pastContext: contextAround(pastText, p.index!, p[0].length),
    });
  }
  const kept = found.filter((e) => !found.some((o) => o !== e && o.keyword.length > e.keyword.length && o.keyword.includes(e.keyword)));
  return kept
    .sort((a, b) => Math.min(b.noticeCount, b.pastCount) - Math.min(a.noticeCount, a.pastCount) || b.keyword.length - a.keyword.length)
    .slice(0, limit);
}
