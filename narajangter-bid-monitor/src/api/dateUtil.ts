/** data.go.kr 나라장터 API가 요구하는 YYYYMMDDHHMM 형식으로 변환 (KST 기준 로컬 시간 사용) */
export function toApiDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * 조회 기간. 시작은 N일 전 날짜의 00:00(KST)으로 내린다 — "지금에서 딱 N일 전 시각"으로 자르면
 * N일 전 날짜에 올라왔어도 지금 시각보다 이른 시간에 올라온 공고가 빠진다
 * (예: 9/29 16:32 조회에서 9/22 14:34 게시 사전규격이 누락됐음).
 */
export function lookbackWindow(now: Date, lookbackDays: number): { begin: Date; end: Date } {
  const end = new Date(now);
  const begin = new Date(now);
  begin.setDate(begin.getDate() - lookbackDays);
  begin.setHours(0, 0, 0, 0);
  return { begin, end };
}

/**
 * 나라장터 목록 API가 한 번에 받는 조회 기간의 최대 길이. 31일을 넘기면 resultCode 07
 * "입력범위값 초과"로 거부된다 (2026-09-30 실측: 정확히 31일은 통과, 32일부터 거부).
 * 30보다 작게 잡으면 "최근 30일"(30일 전 00:00부터라 30일을 조금 넘는다)이 괜히 두 번 조회된다.
 */
export const MAX_QUERY_SPAN_DAYS = 31;

/**
 * 조회 기간을 API 한도 안의 조각으로 나눈다. 이웃한 조각은 경계 시각(분)을 함께 가진다 —
 * 조회 시각이 분 단위라 경계를 1분 띄우면 그 1분 사이에 올라온 공고가 빠질 수 있어서다.
 * 경계에서 두 번 받은 행은 호출부가 걸러낸다.
 */
export function splitWindow(
  window: { begin: Date; end: Date },
  maxDays: number = MAX_QUERY_SPAN_DAYS
): { begin: Date; end: Date }[] {
  const spanMs = maxDays * 86_400_000;
  const chunks: { begin: Date; end: Date }[] = [];
  let start = window.begin.getTime();
  const end = window.end.getTime();
  do {
    const chunkEnd = Math.min(start + spanMs, end);
    chunks.push({ begin: new Date(start), end: new Date(chunkEnd) });
    start = chunkEnd;
  } while (start < end);
  return chunks;
}
