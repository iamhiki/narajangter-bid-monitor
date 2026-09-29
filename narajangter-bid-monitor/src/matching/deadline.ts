import type { NormalizedNotice } from "../api/types.js";

const KST_OFFSET_HOURS = 9;

/**
 * 나라장터 마감일시를 절대 시각으로 바꾼다. 알아볼 수 없는 형식이면 null.
 *
 * 실측 형식은 "2026-10-14 17:00:00"이고 한국 시각이다. GitHub Actions는 UTC로 돌기 때문에
 * `new Date("2026-10-14 17:00:00")`처럼 실행 환경의 시간대에 맡기면 9시간이 어긋난다.
 * 그래서 KST로 못박아 계산한다. 시각 없이 날짜만 오면 그날 23:59까지 유효한 것으로 본다.
 */
export function parseKstDateTime(value: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[ T]?(\d{2}):?(\d{2}))?/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const hour = h === undefined ? 23 : Number(h);
  const minute = mi === undefined ? 59 : Number(mi);
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour - KST_OFFSET_HOURS, minute);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * 마감이 이미 지났는지. 마감일시가 없거나 형식을 알 수 없으면 false — 모르는 공고는
 * 지우지 않는다(판단 근거가 없는데 지우면 실제 기회를 놓칠 수 있다).
 */
export function isDeadlinePassed(deadline: string | null, now: Date): boolean {
  const at = parseKstDateTime(deadline);
  return at !== null && at.getTime() < now.getTime();
}

/**
 * 본공고 중 마감이 지난 것을 뺀다.
 *
 * 수집은 "공고가 올라온 날짜" 기준이라, 올라온 뒤 며칠 안에 마감되는 공고(긴급공고, 소액 견적
 * 등)는 이미 마감된 채로 들어온다. 실측: 7일치 매칭 10건 중 1건이 리포트 생성 시점에 이미
 * 마감돼 있었다. 사전규격에는 쓰지 않는다 — 사전규격의 마감은 입찰 마감이 아니라 의견 등록
 * 마감이고, 그 뒤에 본공고가 나오므로 지나도 의미가 있다.
 */
export function excludeExpiredNotices(
  notices: NormalizedNotice[],
  now: Date
): { open: NormalizedNotice[]; expiredCount: number } {
  const open = notices.filter((n) => !isDeadlinePassed(n.deadline, now));
  return { open, expiredCount: notices.length - open.length };
}

/** 매일 마감 임박 보고에서 보는 기간 (2026-09-29 미팅: "입찰"은 7일 안에 마감되는 경우가 있다) */
export const CLOSING_SOON_DAYS = 7;

/**
 * 아직 마감 전이고 D-`days` 이내(한국 달력 기준)인 공고만 마감 빠른 순으로 골라낸다.
 * 시각 기준(정확히 168시간)으로 자르면 메시지에 "D-7"로 찍히는 공고가 오후 마감이라는 이유로
 * 빠지는 어긋남이 생겨서, 보고에 찍히는 D-day와 같은 기준을 쓴다.
 * 마감일시를 모르는 공고는 뺀다 — 여기는 "곧 마감"을 알리는 자리라 마감을 모르면 넣을 근거가 없다.
 */
export function selectClosingSoon<T extends { notice: NormalizedNotice }>(
  matches: T[],
  now: Date,
  days: number = CLOSING_SOON_DAYS
): T[] {
  return matches
    .map((m) => ({ m, at: parseKstDateTime(m.notice.deadline)?.getTime() ?? null }))
    .filter(
      (x): x is { m: T; at: number } =>
        x.at !== null && x.at >= now.getTime() && daysUntilDeadline(x.m.notice.deadline, now)! <= days
    )
    .sort((a, b) => a.at - b.at)
    .map((x) => x.m);
}

/** 마감까지 남은 날짜 (KST 달력 기준). 오늘 마감이면 0. */
export function daysUntilDeadline(deadline: string | null, now: Date): number | null {
  const at = parseKstDateTime(deadline);
  if (!at) return null;
  const kstDay = (d: Date) => Math.floor((d.getTime() + KST_OFFSET_HOURS * 3_600_000) / 86_400_000);
  return kstDay(at) - kstDay(now);
}
