import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger.js";

/**
 * 매일·주간 보고를 이미 보냈는지 기록한다 — 같은 보고가 두 번 나가지 않게.
 *
 * 보고 하나를 두 곳이 깨운다. 외부 예약 서비스(cron-job.org)가 정시에 먼저 깨우고, GitHub 예약 실행이
 * 한 시간 뒤 예비로 한 번 더 돈다. GitHub 예약 실행은 몇 시간씩 건너뛰기도 해서(2026-09-29 실측)
 * 하나에만 맡기면 보고가 빠지고, 둘 다 보내게 두면 같은 보고를 두 번 받는다. 그래서 먼저 보낸 쪽이
 * 여기 남기고, 뒤에 도는 쪽은 기록을 보고 조용히 끝난다.
 *
 * 실행 사이에 이 파일은 GitHub Actions 캐시로 넘긴다 (.github/workflows/daily-closing-alert.yml,
 * weekly-bid-report.yml). 캐시가 비면(첫 실행, 만료) 한 번 더 나갈 수 있다 — 빠지는 것보다 낫다.
 */
export type ScheduledReport = "daily" | "weekly";

export interface SentReports {
  v: 1;
  /** 보고 종류 → 마지막으로 보낸 기간 (daily는 날짜, weekly는 그 주 월요일 날짜, 한국 시각) */
  last: Partial<Record<ScheduledReport, string>>;
}

/**
 * 같은 보고로 치는 기간. daily는 그날, weekly는 그 주(월요일 날짜).
 * 실행 환경은 TZ=Asia/Seoul이라 지역 시각이 곧 한국 시각이다.
 */
export function reportPeriodKey(kind: ScheduledReport, now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (kind === "weekly") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function loadSentReports(path: string): SentReports {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SentReports>;
    if (parsed.v === 1 && typeof parsed.last === "object" && parsed.last !== null) return { v: 1, last: parsed.last };
    logger.warn("보고 발송 기록 형식이 달라 새로 시작합니다", { path });
  } catch {
    logger.info("보고 발송 기록이 없어 새로 시작합니다", { path });
  }
  return { v: 1, last: {} };
}

export function alreadySent(sent: SentReports, kind: ScheduledReport, now: Date): boolean {
  return sent.last[kind] === reportPeriodKey(kind, now);
}

export function markSent(path: string, sent: SentReports, kind: ScheduledReport, now: Date): void {
  sent.last[kind] = reportPeriodKey(kind, now);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sent, null, 2), "utf8");
}
