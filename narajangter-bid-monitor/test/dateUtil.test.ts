import { describe, expect, it } from "vitest";
import { lookbackWindow, toApiDateTime } from "../src/api/dateUtil.js";

describe("lookbackWindow", () => {
  it("시작을 N일 전 날짜의 00:00으로 내린다 — 그날 이른 시간에 올라온 공고도 들어오게", () => {
    const now = new Date(2026, 8, 29, 16, 32);
    const { begin, end } = lookbackWindow(now, 7);
    expect(toApiDateTime(begin)).toBe("202609220000");
    expect(end.getTime()).toBe(now.getTime());
  });

  it("넘겨준 now는 바꾸지 않는다", () => {
    const now = new Date(2026, 8, 29, 16, 32);
    lookbackWindow(now, 7);
    expect(toApiDateTime(now)).toBe("202609291632");
  });
});
