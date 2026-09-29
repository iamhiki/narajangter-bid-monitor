/**
 * 매시간 알림의 "새 공고" 기준 — 최근 24시간 안에 게시된 공고.
 *
 * 알림은 웹 화면과 같은 7일치를 조회하지만(머리말의 "최근 7일 전체 N건"을 세려고), 보내는 건
 * 예전처럼 하루 안에 올라온 공고만이다. 7일 전체를 새 공고로 보면 기록이 없는 공고(기록 생기기 전에
 * 올라온 것)가 한꺼번에 쏟아진다.
 */
export const NEW_NOTICE_HOURS = 24;

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
