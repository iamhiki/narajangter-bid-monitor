import { describe, expect, it } from "vitest";
import { isPostedWithin } from "../src/state/recency.js";
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
