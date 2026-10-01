/**
 * 제목에 키워드가 없이 조달분류(전시장치설치및디자인서비스)만으로 들어온 공고가 정말 지일 본업인지,
 * 첨부 과업지시서·제안요청서 본문에서 본업 낱말을 찾아 확인한다.
 *
 * 2026-10-01 60일치 시험: '외식 창업 공간 및 야외광장 디자인 개발 및 설치'(19억)는 분류는 같지만 과업지시서에
 * 전시·체험 낱말이 하나도 없었고, '스마트 어린이 교통공원 구축'·'국립인천해양박물관 공간 연출 및 제작·설치'는
 * 제안요청서에 전시물·체험콘텐츠·미디어월이 나왔다.
 */

/** 등록 키워드 외에 과업 본문에서 본업을 뜻하는 말 */
const EXTRA = ["전시물", "전시연출", "전시공간", "전시콘텐츠", "체험물", "실물모형", "디오라마", "전시품"];

export function findCoreWords(text: string, keywords: string[]): string[] {
  const body = text.replace(/\s+/g, "");
  const found: string[] = [];
  for (const word of [...keywords, ...EXTRA]) {
    const w = word.replace(/\s+/g, "");
    if (w && body.includes(w) && !found.includes(w)) found.push(w);
  }
  return found;
}
