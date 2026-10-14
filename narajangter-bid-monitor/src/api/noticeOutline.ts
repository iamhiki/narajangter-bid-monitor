/**
 * 과업지시서가 없는 공고의 "과업 개요" 대용 — 입찰공고문의 개요 항목 + 공내역서의 공종·품명.
 *
 * 2026-10-13 실측: 제목만으로 싱크로율을 매긴 공고 25건 중 대부분이 공사 공고였고, 첨부는 입찰공고문과
 * 공내역서(엑셀)뿐이었다. 공고문을 통째로 쓰면 안 된다 — 입찰방법·참가자격·보험료 같은 행정 문구가
 * 대부분이라 모든 공고가 서로 비슷해진다(attachments.ts의 SPEC_PATTERN 주석과 같은 문제). 그래서
 * 공고문에서는 "공사명·공사개요·사업내용" 같은 개요 줄만, 내역서에서는 공종·품명 칸만 골라 쓴다.
 */

/** 공고문 개요 항목 라벨 — 값이 과업 내용을 말하는 것만. 기간·장소·금액은 뺀다 */
const OUTLINE_LABEL =
  /^\s*(?:[0-9.]+|[가-하][.)]|[ㆍ·○□■◦▪-])?\s*(공\s*사\s*명|공\s*고\s*명|사\s*업\s*명|용\s*역\s*명|과\s*업\s*명|건\s*명|공\s*사\s*개\s*요|사\s*업\s*개\s*요|과\s*업\s*개\s*요|공\s*사\s*내\s*용|사\s*업\s*내\s*용|과\s*업\s*내\s*용|주\s*요\s*내\s*용|주\s*공\s*종|공\s*사\s*범\s*위|사\s*업\s*범\s*위|과\s*업\s*범\s*위|납\s*품\s*내\s*용|구\s*매\s*내\s*용)\s*[:：]?\s*(.*)$/;

/** "붙임파일 참조", "1식" 같은 값은 내용이 없다 */
const EMPTY_VALUE = /^(?:붙임.*참조|별첨.*참조|설계서.*참조|[0-9]*\s*식)?$/;

export function noticeOutline(text: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const m = OUTLINE_LABEL.exec(line);
    if (!m) continue;
    const value = (m[2] ?? "").trim();
    if (EMPTY_VALUE.test(value) || value.length > 200) continue;
    if (!lines.includes(value)) lines.push(value);
    if (lines.length >= 12) break;
  }
  return lines.join("\n");
}

/**
 * 내역서 글자 칸에서 공종·품명만. 실측한 잡음:
 *   공종코드 "ZZB300100000", 고유번호 "5232620562982060BDEA…", 수식 "직접노무비* 3.595%", "(AZZ+BZZ)*%%",
 *   간접비 "국민건강보험료", "하도급지급보증수수료", 표 머리 "단위·수량·JUK1·일위·단산", 규격 "높이 2m, 3개월"
 */
const QTY_NOISE =
  /보험료|노무비|부담금|수수료|공제|관리비|이윤|부가가치세|경비|일반관리|폐기물|원가|합계|소계|TOTAL|호표|산근|일위|단산|자재|손료|적용[률율]|공종(?:코드|구분|레벨|소계|\+)|품목코드|고유번호|상위공종|변수|설정|메모장|조정률|단위|수량|비고|^JUK\d+$|^[A-Z]{2,}\d*$/;

export function quantityItems(text: string, limit = 120): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // 앞의 공종 번호("0102 도장공사", "1-1 공통가설공사")만 떼고 "1층"처럼 품명의 일부인 숫자는 둔다
    const item = raw.replace(/^[\d.\-]+\s+/, "").replace(/^[\[(#\s]+|[\])#\s]+$/g, "").trim();
    if (item.length < 3 || item.length > 60) continue;
    if (!/[가-힣]{2,}/.test(item)) continue;
    if (/[*%=]|[0-9A-F]{12,}/.test(item)) continue;
    if (QTY_NOISE.test(item)) continue;
    // 규격 칸("높이 2m, 3개월", "20t, 콘크리트면 부착시공", "55W 이하")은 숫자+단위가 들어 있다
    if (/\d\s*(?:mm|cm|m|t|T|W|K|kg|ton|개월|회|EA|㎡|㎥)(?![가-힣A-Za-z])/.test(item)) continue;
    if ((item.match(/\d/g) ?? []).length > item.length / 4) continue;
    if (!out.includes(item)) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
