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
