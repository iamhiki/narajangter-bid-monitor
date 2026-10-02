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

/**
 * 제목의 제외 키워드로 빠진 공고를 첨부로 다시 볼 때 쓰는 근거 — 과업 본문에 "전시물 제작·설치"처럼
 * **본업 대상 바로 뒤에 제작·설치가 붙은 말**이 있는지 찾는다 (2026-10-02 요청: 제목만 보고 빼지 말 것).
 *
 * findCoreWords처럼 낱말만 보면 안 된다. 지심도 산마루문화놀이터 명소화 사업(건물 7동 건축 기본·실시설계)
 * 과업내용서에도 "놀이"·"전시"·"콘텐츠"는 나오지만 "제작"은 한 번도 없다. 그냥 "콘텐츠"는 홍보·SNS 운영
 * 공고에도 "콘텐츠 제작"으로 흔히 나와 대상에서 뺐다.
 * 화면에서는 목록에 섞지 않고 따로 모아 담당자가 판단한다 — 근거 문장을 함께 준다.
 */
const MAKE_OBJECTS =
  "전시물|전시품|체험물|체험시설|체험전시물|조형물|상징조형물|놀이시설물?|놀이기구|놀이구조물|실물모형|모형|디오라마|" +
  "전시콘텐츠|실감콘텐츠|영상콘텐츠|체험콘텐츠|미디어아트|미디어월|전시연출|전시시설|전시장치|전시매체|진열장|포토존|키오스크";
const MAKE_EVIDENCE = new RegExp(`(?:${MAKE_OBJECTS})[^.。\n]{0,20}?(?:제작|설치|제조)`, "g");
/** 본업으로 볼 최소 횟수 — 한 번은 참고 문구·예시일 수 있다 */
export const MAKE_EVIDENCE_MIN = 2;

export function findMakeEvidence(text: string, samples = 3): { count: number; samples: { sentence: string; match: string }[] } {
  const flat = text.replace(/\s+/g, " ");
  const found: { sentence: string; match: string }[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const m of flat.matchAll(MAKE_EVIDENCE)) {
    count += 1;
    if (found.length >= samples) continue;
    const from = Math.max(0, m.index! - 30);
    const to = Math.min(flat.length, m.index! + m[0].length + 30);
    const sentence = `${from > 0 ? "…" : ""}${flat.slice(from, to).trim()}${to < flat.length ? "…" : ""}`;
    const key = m[0].replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ sentence, match: m[0] });
  }
  return { count, samples: found };
}
