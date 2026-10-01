/**
 * 과업지시서·제안요청서 본문에서 사람이 읽을 "과업 요약" 부분을 뽑는다.
 *
 * 맨 앞 N자를 자르면 표지("과 업 지 시 서 / 2024. 8. / ○○시")와 목차("Ⅲ. 과업지시서 5 / 1. 과업명")만
 * 보이고 정작 과업 내용은 잘린다(2026-10-01 직접 검색 탭에서 확인). 목차 안에도 "사업목적", "과업의 범위"
 * 같은 제목이 그대로 나와서, 제목을 찾되 목차 줄은 건너뛰어야 한다.
 */

/** 과업 요약이 시작되는 제목. 앞에 있을수록 우선한다 — 개요가 목적·범위·주요 과업을 다 품고 있는 경우가 많다 */
const HEADINGS = [
  /과\s*업\s*(?:의\s*)?개\s*요|사\s*업\s*(?:의\s*)?개\s*요|용\s*역\s*개\s*요|공\s*모\s*개\s*요/,
  // "2. 목 적"처럼 단독으로 쓰인 목적도 받는다 (앞뒤에 다른 한글이 붙지 않을 때만)
  /과\s*업\s*목\s*적|사\s*업\s*목\s*적|추\s*진\s*목\s*적|배경\s*및\s*목적|(?<![가-힣])목\s*적(?![가-힣])/,
  /주요\s*과업\s*내용|과업\s*(?:의\s*)?범위|과업\s*(?:의\s*)?내용|사업\s*(?:의\s*)?범위|사업\s*내용/,
];

/** 목차 점선 — "······", "- - - -", "· · · ·"(점 사이 공백) 모두 */
const LEADER = /(?:[·.…‧\-]\s?){4,}/;
/** 줄 끝 쪽 번호 — "과업의 범위 2", "Ⅰ. 과업개요2", "과업내용 ······ 7" */
const PAGE_TAIL = /(?:[가-힣A-Za-z)]\s?|(?:[·.…‧\-]\s?){4,})\d{1,3}$/;
const ITEM_MARK = "(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+|\\d{1,2}|[가나다라마바사아자차카타파하])";

/** 목차 줄로 보이는가: 쪽 번호 꼬리, 점선, 한 줄에 번호 항목이 여러 개("1. 사업목적 2. 사업내용") */
function looksLikeToc(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const lineEnd = text.indexOf("\n", at);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
  if ((line.match(/(?:^|\s)\d{1,2}\.\s*\S/g) ?? []).length >= 2) return true;
  if (LEADER.test(line) || PAGE_TAIL.test(line)) return true;
  // 목차는 짧은 제목 줄만 이어지고, 본문은 "□ 사 업 명 : …"처럼 긴 줄이 섞인다 (점선·쪽 번호 꼬리 줄은 길어도 목차)
  const nearLines = text.slice(lineStart, lineStart + 600).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8);
  const bodyLike = (l: string) => l.length >= 28 && !LEADER.test(l) && !PAGE_TAIL.test(l);
  if (nearLines.filter(bodyLike).length >= 2) return false;
  const after = text.slice(at, at + 260);
  // 다음 줄들에 쪽 번호만 있는 줄이 둘 이상 — 하나뿐이면 본문 장 번호("Ⅰ. 사업개요 / 1 / 주요사항")일 수 있다
  if ((after.match(/\n[ \t]*\d{1,3}[ \t]*(?=\n)/g) ?? []).length >= 2) return true;
  if (LEADER.test(after)) return true;
  // "1. 사업 개요 2" / "1. 주요사항1"처럼 줄 끝에 쪽 번호가 붙는 목차 — 이어지는 항목 줄 여럿이 그런 모양이면 목차
  const paged = nearLines.slice(0, 7).filter((l) => new RegExp(`^${ITEM_MARK}[.)]\\s*\\S`).test(l) && PAGE_TAIL.test(l));
  return paged.length >= 2;
}

/**
 * 제목은 줄 맨 앞(항목 번호·기호 뒤)에 온다. "가) 협상대상자가 제안한 사업내용…"처럼 문장 속 낱말은 제목이 아니다.
 * 앞에 올 수 있는 것: 쪽 꼬리("- 2 -"), "제1장", "Ⅰ.", "1.", "1.1", "(2)", "가.", "□ ❍ ●" 같은 기호, 한글 문서 글머리(사용자 정의 영역 문자).
 */
const HEADING_PREFIX =
  /^(?:-\s*\d+\s*-\s*)?(?:제\s*\d+\s*[장절]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.?|[IVX]+\.|\d{1,2}(?:\.\d{1,2})*[.)]?|\(\d{1,2}\)|[가나다라마바사아자차카타파하][.)]|[□■❍❑○◦●▶◎※·\--]|[\u{F0000}-\u{FFFFD}])?\s*$/u;

function firstBodyHeading(text: string): number {
  for (const heading of HEADINGS) {
    const re = new RegExp(heading.source, "g");
    for (const m of text.matchAll(re)) {
      const lineStart = text.lastIndexOf("\n", m.index!) + 1;
      if (!HEADING_PREFIX.test(text.slice(lineStart, m.index!).trim())) continue;
      if (!looksLikeToc(text, m.index!)) return lineStart;
    }
  }
  return -1;
}

/** 빈 줄을 하나로 줄이고 줄 앞 공백을 정리한다 — 항목 기호(1), 가., ❍, -)는 그대로 둔다 */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, "").replace(/^\s+/, ""))
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}

/**
 * 과업 요약 발췌. 제목을 못 찾으면 목차·표지를 건너뛴 앞부분을 쓴다.
 * 줄 중간에서 자르지 않는다 — maxLength 근처의 줄 끝까지 담는다.
 */
export function taskExcerpt(body: string, maxLength = 1800): string {
  let text = body.replace(/\r\n?/g, "\n");
  // PDF에서 뽑은 본문 중에는 줄바꿈 없이 한 줄로 이어진 것이 있다 — 항목 번호·기호 앞에서 줄을 나눠 준다
  // 글머리 기호는 뒤에 공백이 올 때만 — "○○시"처럼 이름을 가린 ○에서 줄을 나누지 않는다
  if ((text.match(/\n/g) ?? []).length < text.length / 400) {
    text = text.replace(/\s+(?=(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.|\d{1,2}\.\s|\d{1,2}\)\s|[가나다라마바사아자차카타파하]\.\s|[□■❍❑○◦●▶※]\s))/g, "\n");
  }
  const start = firstBodyHeading(text);
  const from = start >= 0 ? start : 0;
  const slice = tidy(text.slice(from, from + maxLength * 2));
  if (slice.length <= maxLength) return slice;
  const cut = slice.lastIndexOf("\n", maxLength);
  return (cut > maxLength * 0.6 ? slice.slice(0, cut) : slice.slice(0, maxLength)) + "\n…";
}
