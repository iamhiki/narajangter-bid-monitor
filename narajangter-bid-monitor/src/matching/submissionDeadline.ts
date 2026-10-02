/**
 * 공고문에서 제안서(입찰서류) 제출 마감 일시를 읽는다.
 *
 * 협상에의한계약 공고는 나라장터 입찰마감(bidClseDt)이 비어 있는 경우가 많다 — 제안서를 발주처에
 * 직접 들고 가서 내기 때문이다. 그러면 화면에는 개찰 일시밖에 없는데, 실제 제출 마감은 그보다 이를 수 있다.
 * 2026-10-02 개찰일로 마감을 대신한 공고 25건의 공고문 실측:
 *   - 남원 레코드테크 "참가신청 및 제안서 제출 1) 제출일시 : 2026. 9. 22.(화) 10:00 ~ 17:00" — 개찰은 9. 29.
 *   - 온양행궁 표 "제안서 접수 2026. 9. 4.(금) 09:00 ~ …" — 개찰은 9. 7.
 *   - 경기북부어린이박물관 "제출일시: 2026. 10. 1.(목) 10:00~12:00, 13:00~15:00" — 개찰은 같은 날 16:00
 *   - 대부분은 개찰 당일 "10:00 ~ 17:00" 방문 제출이라 개찰 일시와 같다.
 * 나라장터 입찰마감이 있는 공고에도 쓴다 — 나로우주센터는 전자입찰 10:00 마감, 제안서는 같은 날 14:00~15:00 직접 제출.
 *
 * 걸러야 하는 것: "입찰공고 기간", "질의접수", "제안서 평가·발표", "참가 신청기한", 공고일("…문의하시기 바랍니다.
 * 2026년 9월 21일"), 접수 **시작**("입찰서 제출 개시일시"), 날짜 뒤의 "(점심시간 12:00~13:00 제외)"·"(평가위원추첨
 * 17:00~17:30)" 같은 시간. 기간의 끝 날짜는 연도·월을 생략하기도 한다("2026. 9. 18. 15:00 ~ 10. 13. 10:00",
 * "2026. 09. 10.(목) ~ 14.(월) 17:00") — 2026-10-02 입찰마감이 있는 본공고 88건 실측.
 */

export interface SubmissionDeadline {
  /** "2026-09-22 17:00" — 시각을 못 읽으면 날짜만 ("2026-09-22") */
  at: string;
  /** 공고문에 적힌 제출 기간 그대로 ("2026. 10. 2.(금) 13:30 ~17:00") — 화면 설명 박스에 보여 준다 */
  period: string;
  /** 근거 문장 (공고문에서 잘라낸 것) */
  quote: string;
  /** 공고문에 서로 다른 제출 날짜가 함께 적혀 있음 (가장 이른 날짜를 at으로) — 원문 확인 필요 */
  conflict: boolean;
}

/** 제출·접수를 말하는 자리. 질의·현장설명회 신청은 아니다 */
const ANCHOR = /(?:제\s*안\s*서|입\s*찰\s*서\s*류|입\s*찰\s*참\s*가\s*(?:등\s*록|신\s*청)|입\s*찰\s*등\s*록|입\s*찰\s*서)[^.。]{0,12}?(?:제\s*출|접\s*수)/g;
/** 자리와 날짜 사이에 이런 말이 있으면 다른 일정이다 (개시·시작은 접수 시작 일시) */
const OTHER_SCHEDULE =
  /공\s*고|질\s*의|설\s*명\s*회|평\s*가|발\s*표|심\s*사|개\s*찰|안\s*내\s*사\s*항|통\s*보|신\s*청|문\s*의|개\s*시|시\s*작|공\s*동\s*수\s*급|협\s*정\s*서/;
/** 자리에서 날짜까지 허용하는 거리 — 표 머리("제출일시 제출장소 제출방법 제출자 제출서류")가 낄 만큼 */
const ANCHOR_TO_DATE = 70;
/** 날짜 바로 앞에 붙는 제출 일정 표현 — "제출기한 :", "접수마감일시 :" 뒤에 날짜가 곧바로 와야 한다 */
const LABELED = /(?:제\s*출|접\s*수)\s*(?:기\s*한|일\s*시|기\s*간|마\s*감\s*(?:일\s*시|일\s*자|시\s*간)?)\s*[:：]?\s*(?=20\d\d\s*[.년/-])/g;
/**
 * LABELED 앞에서 어떤 일정인지 가르는 말 — 가장 가까운 것이 제안서·입찰서여야 제출 마감이다.
 * "공동수급협정서 : … 1) 제출기한 : 2026. 9. 1.(화) 18:00까지"는 협정서 기한이다 (대전시립박물관 특별전)
 */
const CONTEXT_WORD =
  /제\s*안\s*서|입\s*찰\s*서|질\s*의|현\s*장|설\s*명\s*회|평\s*가|발\s*표|공\s*고|공\s*동\s*수\s*급|협\s*정\s*서|확\s*인\s*서|증\s*명\s*서/g;
const CONTEXT_SPAN = 160;
const WEEKDAY = String.raw`(?:\s*[(（][^)）]{1,3}[)）])?`;
const DATE = new RegExp(String.raw`(20\d\d)\s*[.년/-]\s*(\d{1,2})\s*[.월/-]\s*(\d{1,2})\s*일?\.?` + WEEKDAY + String.raw`\s*`, "y");
/** 기간 끝의 연도 없는 날짜 — "10. 13.(화)", "9.14." */
const MONTH_DAY = new RegExp(String.raw`^(\d{1,2})\s*[.월/-]\s*(\d{1,2})\s*일?\.?` + WEEKDAY + String.raw`\s*`);
/** 기간 끝의 일만 있는 날짜 — "14.(월)" (요일이 붙어야 시각과 헷갈리지 않는다) */
const DAY_ONLY = /^(\d{1,2})\s*일?\.?\s*[(（][^)）]{1,3}[)）]\s*/;
const TIME = /(\d{1,2})\s*:\s*(\d{2})/g;
/** 기간을 잇는 말 */
const RANGE = /[~∼～]|부\s*터/;
/** 시간 범위를 읽다가 멈출 자리 — 다음 낱말(제출장소·점심시간 등), 다음 항목 기호, 시간이 아닌 괄호 */
// 한글 낱말은 "부 가 가 치 세"처럼 글자 사이가 띄어진 표 글씨도 낱말로 본다 (충주 공공미술 — 뒤의 "개 찰 일 시 … 11:00"을 읽었다)
const TAIL_STOP =
  /(?!부\s*터|까\s*지)[가-힣](?:\s?[가-힣])+|※|(?<![\d:])\d{1,2}\)\s|[가-하]\.\s|[(（](?!\s*\d{1,2}\s*:\s*\d{2}\s*[~∼～])(?![월화수목금토일][)）])|[(（](?=\s*\d{1,2}\s*:\s*\d{2}\s*[~∼～][^)）]*제\s*외)/;

const pad = (n: string | number) => String(n).padStart(2, "0");

/** 날짜 하나 뒤의 시간 범위를 잘라 낸다 (TAIL_STOP 앞까지) */
function tailAfter(text: string, from: number): string {
  const tail = text.slice(from, from + 90);
  const stop = tail.search(TAIL_STOP);
  return stop >= 0 ? tail.slice(0, stop) : tail;
}

/**
 * at에서 시작하는 날짜와, 이어지는 기간의 **끝** 날짜·시각. end는 읽은 범위가 끝나는 위치.
 * "2026. 9. 4.(금) 09:00 ~ 2026. 9. 7.(월) 18:00" → 9-07 18:00, "2026. 9. 18. 15:00 ~ 10. 13. 10:00" → 10-13 10:00,
 * "2026/09/01 10:00:00 2026/09/03 10:00:00"(표의 시작·마감 칸) → 9-03 10:00
 */
function readWhen(text: string, at: number): { date: string; time: string | null; end: number } | null {
  DATE.lastIndex = at;
  const d = DATE.exec(text);
  if (!d) return null;
  const [y, mo] = [d[1]!, d[2]!];
  const start = `${y}-${pad(mo)}-${pad(d[3]!)}`;
  const tailFrom = DATE.lastIndex;
  const tail = tailAfter(text, tailFrom);

  const lastTime = (s: string, base: number) => {
    const t = [...s.matchAll(TIME)].pop();
    return t ? { time: `${pad(t[1]!)}:${t[2]}`, end: base + t.index! + t[0].length } : null;
  };

  // 기간: 시작 날짜 뒤 "~"/"부터" 다음의 끝 날짜
  const r = RANGE.exec(tail);
  if (r) {
    const restAt = tailFrom + r.index + r[0].length;
    const rest = text.slice(restAt).replace(/^\s+/, "");
    const restFrom = restAt + (text.slice(restAt).length - rest.length);
    let endDate: string | null = null;
    let consumed = 0;
    DATE.lastIndex = 0;
    const full = new RegExp(DATE.source).exec(rest);
    const md = MONTH_DAY.exec(rest);
    const dd = DAY_ONLY.exec(rest);
    if (full && full.index === 0) {
      endDate = `${full[1]}-${pad(full[2]!)}-${pad(full[3]!)}`;
      consumed = full[0].length;
    } else if (md && !/^\d{1,2}\s*:/.test(rest)) {
      endDate = `${y}-${pad(md[1]!)}-${pad(md[2]!)}`;
      consumed = md[0].length;
    } else if (dd) {
      endDate = `${y}-${pad(mo)}-${pad(dd[1]!)}`;
      consumed = dd[0].length;
    }
    if (endDate) {
      const after = tailAfter(text, restFrom + consumed);
      const t = lastTime(after.split(RANGE)[0]!, restFrom + consumed);
      return { date: endDate, time: t?.time ?? null, end: t?.end ?? restFrom + consumed };
    }
  }

  // 표의 시작·마감 칸이 나란히: "2026/09/01 10:00:00 2026/09/03 10:00:00"
  const firstTime = /^\s*(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*\d{2})?\s*/.exec(tail);
  if (firstTime) {
    const nextAt = tailFrom + firstTime[0].length;
    DATE.lastIndex = nextAt;
    const next = DATE.exec(text);
    if (next) {
      const t = lastTime(tailAfter(text, DATE.lastIndex), DATE.lastIndex);
      return { date: `${next[1]}-${pad(next[2]!)}-${pad(next[3]!)}`, time: t?.time ?? null, end: t?.end ?? DATE.lastIndex };
    }
  }

  const t = lastTime(tail, tailFrom);
  return { date: start, time: t?.time ?? null, end: t?.end ?? tailFrom };
}

/** "2026. 10. 22.(목)(09:00 ~ 17:00"처럼 시각에서 끊겨 닫히지 않은 괄호를 닫는다 */
function closeParens(s: string): string {
  const open = (s.match(/[(（]/g) ?? []).length - (s.match(/[)）]/g) ?? []).length;
  return open > 0 ? s + ")".repeat(open) : s;
}

export function findSubmissionDeadline(fullText: string): SubmissionDeadline | null {
  const t = fullText.replace(/\s+/g, " ");
  const found: { at: string; period: string; quote: string }[] = [];
  const add = (labelAt: number, dateAt: number) => {
    const when = readWhen(t, dateAt);
    if (!when) return;
    found.push({
      at: when.time ? `${when.date} ${when.time}` : when.date,
      period: closeParens(t.slice(dateAt, when.end).replace(/\s*(?:부\s*터|까\s*지)\s*$/, "").trim()),
      quote: t.slice(labelAt, Math.min(t.length, Math.max(when.end, dateAt + 40))).trim(),
    });
  };
  for (const m of t.matchAll(ANCHOR)) {
    const from = m.index! + m[0].length;
    const window = t.slice(from, from + ANCHOR_TO_DATE);
    const dateAt = window.search(/20\d\d\s*[.년/-]\s*\d{1,2}\s*[.월/-]\s*\d{1,2}/);
    if (dateAt < 0) continue;
    if (OTHER_SCHEDULE.test(window.slice(0, dateAt))) continue;
    add(m.index!, from + dateAt);
  }
  // "제출기한 : 2026. 10. 15. 14:00~17:00"처럼 날짜 바로 앞의 표현으로도 찾는다 — "가격제안서(입찰서) 제출 … 1) 제출처 :
  // 천안시청 11층 …(☏…) 2) 제출기한 : …"처럼 제출처·전화번호가 끼면 위 방식의 거리를 넘는다 (태조왕건 동상 공고문).
  // 앞 문맥에서 가장 가까운 말이 제안서·입찰서일 때만 — "질의접수 및 회신 1) 접수일시 : …"는 질의 일정이다.
  for (const m of t.matchAll(LABELED)) {
    const before = t.slice(Math.max(0, m.index! - CONTEXT_SPAN), m.index!);
    const last = [...before.matchAll(CONTEXT_WORD)].pop();
    if (!last || !/제|입/.test(last[0][0]!)) continue;
    add(m.index!, m.index! + m[0].length);
  }
  if (!found.length) return null;
  const dates = [...new Set(found.map((f) => f.at.slice(0, 10)))].sort();
  const first = dates[0]!;
  // 같은 날짜면 시각이 있는 것 중 가장 늦은 시각 (접수 창구가 닫히는 때)
  const sameDay = found.filter((f) => f.at.startsWith(first));
  const best = sameDay.filter((f) => f.at.length > 10).sort((a, b) => b.at.localeCompare(a.at))[0] ?? sameDay[0]!;
  return { at: best.at, period: best.period, quote: best.quote, conflict: dates.length > 1 };
}
