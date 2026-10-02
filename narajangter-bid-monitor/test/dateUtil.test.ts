import { describe, expect, it } from "vitest";
import { lookbackWindow, splitWindow, toApiDateTime } from "../src/api/dateUtil.js";

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

describe("splitWindow", () => {
  const DAY = 86_400_000;

  it("API 한도(31일) 이내면 그대로 한 조각 — '최근 30일'은 한 번에 조회된다", () => {
    const window = lookbackWindow(new Date(2026, 8, 30, 15, 0), 30);
    expect(splitWindow(window)).toEqual([window]);
  });

  it("넘으면 31일 조각으로 나누고, 이웃한 조각은 경계 시각을 함께 가진다 (빈틈 없음)", () => {
    const window = lookbackWindow(new Date(2026, 8, 30, 15, 0), 60);
    const chunks = splitWindow(window);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.begin).toEqual(window.begin);
    expect(chunks.at(-1)!.end).toEqual(window.end);
    for (const [i, c] of chunks.entries()) {
      expect(c.end.getTime() - c.begin.getTime()).toBeLessThanOrEqual(31 * DAY);
      if (i > 0) expect(c.begin).toEqual(chunks[i - 1]!.end);
    }
  });
});
