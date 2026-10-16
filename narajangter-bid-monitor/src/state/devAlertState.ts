import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger.js";

/**
 * 개발자에게 알린 "아직 안 풀린 문제" 기록 — 다음 실행이 보고를 정상으로 보내면 "해결됨"을 알리려고 남긴다.
 *
 * 2026-10-16 요청: 실패 알림만 오면 그 뒤에 풀렸는지 실행 기록을 일일이 열어 봐야 한다.
 * 보고 종류(매일·주간)마다 하나씩 둔다. 실행 사이에는 GitHub Actions 캐시로 넘긴다
 * (daily-closing-alert.yml, weekly-bid-report.yml). 캐시가 비면 해결 알림 하나가 빠질 뿐이다.
 */
export interface OpenIssue {
  /** 처음 실패한 시각 (ISO) */
  since: string;
  /** 마지막으로 문제가 난 시각 (ISO) — 이번 실행 중에 또 났는지 가리는 데 쓴다 */
  lastSeen: string;
  /** 무슨 문제였는지 한 줄 (describeFailure 결과 등) */
  summary: string;
}

export interface DevAlertState {
  v: 1;
  open: Partial<Record<string, OpenIssue>>;
}

export function loadDevAlertState(path: string): DevAlertState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DevAlertState>;
    if (parsed.v === 1 && typeof parsed.open === "object" && parsed.open !== null) return { v: 1, open: parsed.open };
  } catch {
    // 처음 실행이거나 캐시가 비었다 — 열린 문제 없음으로 시작
  }
  return { v: 1, open: {} };
}

export function saveDevAlertState(path: string, state: DevAlertState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    logger.warn("개발자 알림 기록 저장 실패 (해결 알림이 빠질 수 있습니다)", { error: String(err) });
  }
}

/** 문제를 연다. 이미 열려 있으면 처음 시각은 두고 마지막 시각·내용만 최신으로 바꾼다. */
export function openIssue(state: DevAlertState, kind: string, summary: string, now: Date): void {
  const since = state.open[kind]?.since ?? now.toISOString();
  state.open[kind] = { since, lastSeen: now.toISOString(), summary };
}

/**
 * 이번 실행 전에 열린 문제가 있으면 닫고 돌려준다. 이번 실행 중에 연 문제(일부 대화방 발송 실패 등)는
 * 아직 안 풀린 것이라 그대로 둔다.
 */
export function closeIssueOpenedBefore(state: DevAlertState, kind: string, runStartedAt: Date): OpenIssue | null {
  const issue = state.open[kind];
  if (!issue || Date.parse(issue.lastSeen ?? issue.since) >= runStartedAt.getTime()) return null;
  delete state.open[kind];
  return issue;
}
