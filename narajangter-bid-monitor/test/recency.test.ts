import { describe, expect, it } from "vitest";
import {
  dailyPeriod,
  isKstWeekend,
  isPostedIn,
  isPostedWithin,
  kstDateKey,
  previousDays,
} from "../src/state/recency.js";
import { buildTelegramMessages } from "../src/notify/telegramMessage.js";
import type { ReportInput } from "../src/report/buildReport.js";

describe("isPostedWithin (한국 시각 게시일)", () => {
  const now = new Date("2026-09-29T06:00:00Z"); // 한국 15:00

  it("24시간 안이면 새 공고", () => {
    expect(isPostedWithin("2026-09-28 16:00:00", now)).toBe(true);
    expect(isPostedWithin("2026-09-29 14:59:00", now)).toBe(true);
  });

  it("24시간이 넘으면 새 공고가 아니다", () => {
    expect(isPostedWithin("2026-09-28 14:59:00", now)).toBe(false);
  });

  it("게시일을 모르면 보낸다", () => {
    expect(isPostedWithin(null, now)).toBe(true);
    expect(isPostedWithin("알수없음", now)).toBe(true);
  });
});

describe("새 공고 알림 머리말", () => {
  const empty = { matches: [], failures: [] } as unknown as ReportInput["bid"];
  const input = {
    generatedAt: new Date("2026-09-29T06:00:00Z"),
    window: { begin: new Date(), end: new Date() },
    bid: empty,
    preStandard: empty,
  } as unknown as ReportInput;

  it("기간 전체 개수를 함께 적는다", () => {
    const [head] = buildTelegramMessages(input, { kind: "new", windowTotal: { days: 7, count: 13 } });
    expect(head).toContain("최근 7일 전체 13건 중 새로 올라온 공고만 보냅니다");
  });

  it("전체 개수를 안 주면 적지 않는다", () => {
    const [head] = buildTelegramMessages(input, { kind: "new" });
    expect(head).not.toContain("최근 7일 전체");
  });
});

describe("정기 보고 게시일 범위 (한국 날짜)", () => {
  // 2026-10-15(목) 09:00 한국 = 00:00 UTC
  const now = new Date("2026-10-15T00:00:00Z");

  it("매일 보고는 전날, 주간 보고는 지난 7일", () => {
    expect(previousDays(now, 1)).toEqual({ from: "2026-10-14", to: "2026-10-14" });
    expect(previousDays(now, 7)).toEqual({ from: "2026-10-08", to: "2026-10-14" });
  });

  it("매일 보고는 평일만 — 월요일은 금~일 게시분을 받는다", () => {
    // 10/17(토)·10/18(일) 09:00 한국은 주말, 10/19(월)·10/16(금)은 평일
    expect(isKstWeekend(new Date("2026-10-17T00:00:00Z"))).toBe(true);
    expect(isKstWeekend(new Date("2026-10-18T00:00:00Z"))).toBe(true);
    expect(isKstWeekend(new Date("2026-10-16T00:00:00Z"))).toBe(false);
    // UTC로는 일요일 밤이어도 한국은 월요일
    expect(isKstWeekend(new Date("2026-10-18T16:00:00Z"))).toBe(false);
    expect(dailyPeriod(new Date("2026-10-19T00:00:00Z"))).toEqual({ from: "2026-10-16", to: "2026-10-18" });
    expect(dailyPeriod(now)).toEqual({ from: "2026-10-14", to: "2026-10-14" });
  });

  it("UTC로는 전날이어도 한국 날짜로 계산한다", () => {
    expect(kstDateKey(new Date("2026-10-14T15:30:00Z"))).toBe("2026-10-15");
  });

  it("게시일이 범위 안인지 날짜로 본다 (양끝 포함)", () => {
    const period = { from: "2026-10-08", to: "2026-10-14" };
    expect(isPostedIn("2026-10-08 00:01:00", period)).toBe(true);
    expect(isPostedIn("2026-10-14 23:59:00", period)).toBe(true);
    expect(isPostedIn("2026-10-15 00:00:00", period)).toBe(false);
    expect(isPostedIn("2026-10-07 23:59:00", period)).toBe(false);
    expect(isPostedIn(null, period)).toBe(true);
  });
});
