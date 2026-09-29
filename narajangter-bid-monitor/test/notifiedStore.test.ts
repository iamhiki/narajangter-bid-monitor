import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyState,
  isNotified,
  loadNotifiedState,
  markNotified,
  saveNotifiedState,
  recordFailure,
  shouldSendFailureAlert,
} from "../src/state/notifiedStore.js";

const dir = mkdtempSync(join(tmpdir(), "notified-"));

describe("알림 기록", () => {
  it("파일이 없으면 빈 기록으로 시작한다 (첫 실행, 캐시 만료)", () => {
    expect(loadNotifiedState(join(dir, "none.json"))).toEqual(emptyState());
  });

  it("깨진 파일이면 실행을 멈추지 않고 빈 기록으로 시작한다", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json", "utf8");
    expect(loadNotifiedState(path)).toEqual(emptyState());
  });

  it("보낸 공고를 기록하고, 다시 읽어도 기억한다", () => {
    const path = join(dir, "roundtrip.json");
    const now = new Date("2026-09-28T01:00:00Z");
    const state = emptyState();
    markNotified(state, ["R26BK001", "R26BK002"], now);
    saveNotifiedState(path, state, now);

    const loaded = loadNotifiedState(path);
    expect(isNotified(loaded, "R26BK001")).toBe(true);
    expect(isNotified(loaded, "R26BK999")).toBe(false);
  });

  it("처음 알린 시각은 다시 표시해도 바뀌지 않는다", () => {
    const state = emptyState();
    markNotified(state, ["A"], new Date("2026-09-01T00:00:00Z"));
    markNotified(state, ["A"], new Date("2026-09-02T00:00:00Z"));
    expect(state.notified.A).toBe("2026-09-01T00:00:00.000Z");
  });

  it("21일보다 오래된 기록은 저장할 때 정리한다", () => {
    const path = join(dir, "prune.json");
    const state = emptyState();
    state.notified.OLD = "2026-08-01T00:00:00.000Z";
    state.notified.RECENT = "2026-09-27T00:00:00.000Z";
    saveNotifiedState(path, state, new Date("2026-09-28T00:00:00Z"));
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(saved.notified)).toEqual(["RECENT"]);
  });
});

describe("실패 알림 간격", () => {
  it("한 번 실패로는 알리지 않고, 두 번 연속이면 알린다", () => {
    const state = emptyState();
    recordFailure(state);
    expect(shouldSendFailureAlert(state, new Date())).toBe(false);
    recordFailure(state);
    expect(shouldSendFailureAlert(state, new Date())).toBe(true);
  });

  it("연속 실패 횟수가 저장·복원된다", () => {
    const path = join(dir, "failures.json");
    const state = emptyState();
    recordFailure(state);
    saveNotifiedState(path, state, new Date());
    expect(loadNotifiedState(path).consecutiveFailures).toBe(1);
  });

  it("6시간 안에는 다시 보내지 않고, 지나면 보낸다", () => {
    const state = { ...emptyState(), consecutiveFailures: 3, lastFailureAlertAt: "2026-09-28T00:00:00.000Z" };
    expect(shouldSendFailureAlert(state, new Date("2026-09-28T05:59:00Z"))).toBe(false);
    expect(shouldSendFailureAlert(state, new Date("2026-09-28T06:00:00Z"))).toBe(true);
  });
});
