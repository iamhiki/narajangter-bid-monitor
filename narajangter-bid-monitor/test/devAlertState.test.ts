import { describe, expect, it } from "vitest";
import { closeIssueOpenedBefore, openIssue, type DevAlertState } from "../src/state/devAlertState.js";
import { buildDevResolvedText } from "../src/notify/devAlert.js";

describe("개발자 알림 기록 (해결 알림)", () => {
  const morning = new Date("2026-10-16T00:00:00Z"); // 09:00 KST 실패
  const backupStart = new Date("2026-10-16T01:10:00Z"); // 10:10 KST 예비 실행 시작

  it("앞 실행에서 연 문제는 이번 실행이 정상이면 닫힌다", () => {
    const state: DevAlertState = { v: 1, open: {} };
    openIssue(state, "daily", "나라장터 접속 실패 — 대개 일시적", morning);
    const closed = closeIssueOpenedBefore(state, "daily", backupStart);
    expect(closed?.summary).toBe("나라장터 접속 실패 — 대개 일시적");
    expect(state.open.daily).toBeUndefined();
  });

  it("이번 실행 중에 또 문제가 나면 닫지 않는다 (처음 시각은 유지)", () => {
    const state: DevAlertState = { v: 1, open: {} };
    openIssue(state, "daily", "나라장터 접속 실패", morning);
    openIssue(state, "daily", "일부 대화방 발송 실패", new Date("2026-10-16T01:12:00Z"));
    expect(closeIssueOpenedBefore(state, "daily", backupStart)).toBeNull();
    expect(state.open.daily?.since).toBe(morning.toISOString());
  });

  it("열린 문제가 없거나 다른 보고의 문제면 아무것도 안 한다", () => {
    const state: DevAlertState = { v: 1, open: {} };
    openIssue(state, "weekly", "텔레그램 발송 실패", morning);
    expect(closeIssueOpenedBefore(state, "daily", backupStart)).toBeNull();
    expect(state.open.weekly).toBeDefined();
  });

  it("해결 알림에 무슨 문제였는지와 어느 실행에서 풀렸는지 적는다", () => {
    const text = buildDevResolvedText({
      runMode: "daily",
      issue: { since: morning.toISOString(), summary: "나라장터 접속 실패 — 대개 일시적" },
      resolvedAt: backupStart,
      backupRun: true,
      runUrl: "https://github.com/x/y/actions/runs/1",
    });
    expect(text).toContain("✅ 매일 입찰 공고 보고 정상화");
    expect(text).toContain("문제: 나라장터 접속 실패 — 대개 일시적");
    expect(text).toContain("예비 실행에서 보고를 정상 발송했습니다");
    expect(text).toContain("actions/runs/1");
  });
});
