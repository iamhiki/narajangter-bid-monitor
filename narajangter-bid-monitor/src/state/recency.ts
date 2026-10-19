/**
 * 매시간 알림의 "새 공고" 기준 — 최근 24시간 안에 게시된 공고.
 *
 * 알림은 웹 화면과 같은 7일치를 조회하지만(머리말의 "최근 7일 전체 N건"을 세려고), 보내는 건
 * 예전처럼 하루 안에 올라온 공고만이다. 7일 전체를 새 공고로 보면 기록이 없는 공고(기록 생기기 전에
 * 올라온 것)가 한꺼번에 쏟아진다.
 */
export const NEW_NOTICE_HOURS = 24;

/**
 * 매일 아침 새 입찰 공고 알림의 "새 공고" 기준 — 최근 48시간 안에 게시된 공고.
 * 하루치보다 넉넉히 잡아 하루 실행이 빠져도 다음 날 잡히게 한다. 이미 알린 공고는 알림 기록으로
 * 거르므로 겹쳐 봐도 두 번 가지 않는다.
 */
export const NEW_BID_HOURS = 48;

/**
 * 게시일시가 now 기준 hours 안인지. 나라장터 게시일시는 한국 시각 "2026-09-29 10:00:00" 형태다.
 * 형식을 모르거나 비어 있으면 true — 모르면 보내는 쪽이 놓치는 쪽보다 낫다.
 */
export function isPostedWithin(postedAt: string | null, now: Date, hours = NEW_NOTICE_HOURS): boolean {
  const m = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[ T]?(\d{2}):?(\d{2}))?/.exec(String(postedAt ?? "").trim());
  if (!m) return true;
  const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, (m[4] === undefined ? 0 : +m[4]) - 9, m[5] === undefined ? 0 : +m[5]);
  return now.getTime() - at <= hours * 60 * 60 * 1000;
}

/**
 * 정기 보고가 다루는 게시일 범위 (한국 날짜, 양끝 포함, "YYYY-MM-DD").
 *
 * 2026-10-15 담당자 정리: 매일 09:00 보고는 "전날 게시분", 매주 월 09:10 보고는 "지난 7일 게시분".
 * 2026-10-19: 매일 보고는 평일만 — 월요일 보고가 금~일 게시분을 받는다 (dailyPeriod).
 * 날짜로 끊으므로 하루 단위로 겹치거나 비는 날이 없다 — 이미 알린 공고 기록(notified.json)이 필요 없다.
 */
export interface PostedPeriod {
  from: string;
  to: string;
}

const KST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** now 기준 한국 날짜에서 offsetDays만큼 옮긴 날짜 ("YYYY-MM-DD"). 실행 환경 시간대와 무관하다. */
export function kstDateKey(now: Date, offsetDays = 0): string {
  return new Date(now.getTime() + KST_MS + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** 오늘(한국 날짜) 직전 days일. days=1이면 전날, days=7이면 지난 7일. */
export function previousDays(now: Date, days: number): PostedPeriod {
  return { from: kstDateKey(now, -days), to: kstDateKey(now, -1) };
}

/** now의 한국 요일 (0=일 … 6=토). 실행 환경 시간대와 무관하다. */
export function kstWeekday(now: Date): number {
  return new Date(now.getTime() + KST_MS).getUTCDay();
}

/** 한국 날짜로 토·일인지 — 매일 입찰 보고는 주말에 보내지 않는다 (2026-10-19 담당자 요청: 평일만) */
export function isKstWeekend(now: Date): boolean {
  const day = kstWeekday(now);
  return day === 0 || day === 6;
}

/**
 * 매일 입찰 보고가 다루는 게시일 범위. 평일은 전날 하루, 월요일은 금~일 사흘 —
 * 주말에는 보고를 보내지 않으므로 금·토 게시분을 월요일 보고에 함께 담는다.
 */
export function dailyPeriod(now: Date): PostedPeriod {
  return previousDays(now, kstWeekday(now) === 1 ? 3 : 1);
}

/**
 * 게시일이 기간 안인지. 나라장터 게시일시는 한국 시각 "2026-10-14 10:00:00" 형태다.
 * 형식을 모르거나 비어 있으면 true — 모르면 보내는 쪽이 놓치는 쪽보다 낫다.
 */
export function isPostedIn(postedAt: string | null, period: PostedPeriod): boolean {
  const m = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})/.exec(String(postedAt ?? "").trim());
  if (!m) return true;
  const key = `${m[1]}-${m[2]}-${m[3]}`;
  return key >= period.from && key <= period.to;
}

/** 첨부 리포트의 조회 기간 표시용 — 기간 첫날 00:00 ~ 마지막 날 23:59 (한국 시각) */
export function periodWindow(period: PostedPeriod): { begin: Date; end: Date } {
  return {
    begin: new Date(Date.parse(`${period.from}T00:00:00+09:00`)),
    end: new Date(Date.parse(`${period.to}T23:59:59+09:00`)),
  };
}
