import { describe, expect, it } from "vitest";
import { buildDevAlertPayload, buildDevAlertText, describeFailure } from "../src/notify/devAlert.js";

// 2026-10-07 실제 실패 원문
const NETWORK_FAILURE =
  "ApiError: [전체조회] 본공고/사전규격 조회가 모두 실패했습니다. API 키/네트워크 상태를 확인하세요.\n" +
  "    at collectReportInput (/home/runner/work/narajangter-bid-monitor/src/pipeline.ts:115:11)";

describe("describeFailure", () => {
  it("접속 끊김은 키 문제가 아니라 접속 실패로 분류한다", () => {
    expect(describeFailure(NETWORK_FAILURE)).toContain("접속 실패");
  });
  it("키가 거절되면 키 확인 필요로 분류한다", () => {
    expect(describeFailure("본공고 조회 실패 (HTTP 401): SERVICE_KEY_IS_NOT_REGISTERED_ERROR")).toContain("키 거절");
  });
});

describe("buildDevAlertText", () => {
  const base = { runMode: "daily" as const, errorMessage: NETWORK_FAILURE, occurredAt: new Date(2026, 9, 7, 8, 22) };

  it("아침 실행 실패는 예비 실행이 다시 시도한다고 적고, 원문과 실행 기록 링크를 싣는다", () => {
    const text = buildDevAlertText({ ...base, backupRun: false, runUrl: "https://github.com/x/y/actions/runs/1" });
    expect(text).toContain("매일 새 입찰 공고 알림 실패");
    expect(text).toContain("예비 실행이 다시 시도합니다");
    expect(text).toContain("https://github.com/x/y/actions/runs/1");
    expect(text).toContain("pipeline.ts:115:11");
  });

  it("예비 실행까지 실패하면 이번 보고가 빠졌다고 적는다", () => {
    expect(buildDevAlertText({ ...base, backupRun: true })).toContain("이번 보고가 빠졌습니다");
  });

  it("긴 원문은 Discord 상한(2000자) 안으로 자른다", () => {
    const text = buildDevAlertText({ ...base, backupRun: false, errorMessage: "x".repeat(10000) });
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});

describe("buildDevAlertPayload", () => {
  it("Discord는 content, Slack은 text, 그 밖은 둘 다", () => {
    expect(buildDevAlertPayload("https://discord.com/api/webhooks/1/abc", "hi")).toEqual({ content: "hi" });
    expect(buildDevAlertPayload("https://hooks.slack.com/services/T/B/x", "hi")).toEqual({ text: "hi" });
    expect(buildDevAlertPayload("https://example.com/hook", "hi")).toEqual({ text: "hi", content: "hi" });
  });
});
