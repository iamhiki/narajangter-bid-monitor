import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger.js";

/**
 * 이미 텔레그램으로 알린 공고 기록.
 *
 * 매시간 확인은 최근 하루치를 겹쳐서 조회한다. GitHub Actions 예약 실행은 늦게 시작되거나
 * 가끔 건너뛰기도 해서, 딱 한 시간치만 보면 그 사이에 올라온 공고를 놓친다. 겹쳐 보는 대신
 * 이 기록으로 이미 보낸 공고를 걸러 "새 공고"만 보낸다.
 *
 * 실행 사이에 이 파일은 GitHub Actions 캐시로 넘긴다(.github/workflows/hourly-bid-alert.yml).
 * 캐시가 비어 있으면(첫 실행, 캐시 만료) 최근 하루치 매칭이 한 번 더 나갈 수 있다 — 놓치는 것보다 낫다.
 */
export interface NotifiedState {
  v: 1;
  /** 공고번호 → 처음 알린 시각(ISO) */
  notified: Record<string, string>;
  /** 마지막으로 실행 실패 알림을 보낸 시각. 장애가 이어질 때 매시간 알림이 쌓이지 않게 한다. */
  lastFailureAlertAt?: string;
}

/** 조회 기간(하루)보다 충분히 길게 잡는다. 이보다 오래된 기록은 다시 조회될 일이 없다. */
const RETENTION_DAYS = 21;

export function emptyState(): NotifiedState {
  return { v: 1, notified: {} };
}

export function loadNotifiedState(path: string): NotifiedState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    logger.info("알림 기록이 없어 새로 시작합니다", { path });
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NotifiedState>;
    if (parsed.v !== 1 || typeof parsed.notified !== "object" || parsed.notified === null) {
      throw new Error("형식이 다름");
    }
    return { v: 1, notified: parsed.notified, lastFailureAlertAt: parsed.lastFailureAlertAt };
  } catch (err) {
    logger.warn("알림 기록을 읽지 못해 새로 시작합니다", { path, error: String(err) });
    return emptyState();
  }
}

export function saveNotifiedState(path: string, state: NotifiedState, now: Date): void {
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const notified: Record<string, string> = {};
  for (const [noticeNo, at] of Object.entries(state.notified)) {
    if (Date.parse(at) >= cutoff) notified[noticeNo] = at;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...state, notified }, null, 2), "utf8");
}

export function isNotified(state: NotifiedState, noticeNo: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.notified, noticeNo);
}

export function markNotified(state: NotifiedState, noticeNos: string[], now: Date): void {
  for (const noticeNo of noticeNos) {
    if (!isNotified(state, noticeNo)) state.notified[noticeNo] = now.toISOString();
  }
}

/** 실패 알림은 6시간에 한 번만. 장애가 몇 시간 이어지면 매시간 같은 알림이 쌓이기 때문이다. */
export const FAILURE_ALERT_INTERVAL_HOURS = 6;

export function shouldSendFailureAlert(state: NotifiedState, now: Date): boolean {
  if (!state.lastFailureAlertAt) return true;
  return now.getTime() - Date.parse(state.lastFailureAlertAt) >= FAILURE_ALERT_INTERVAL_HOURS * 60 * 60 * 1000;
}
