import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alreadySent, loadSentReports, markSent, reportPeriodKey } from "../src/state/sentReports.js";

// 테스트는 지역 시각으로 날짜를 만든다 — 실행 환경의 TZ와 상관없이 같은 결과가 나온다.
const fri = new Date(2026, 9, 2, 8, 10); // 2026-10-02 금
const mon = new Date(2026, 9, 5, 7, 0); // 2026-10-05 월

describe("reportPeriodKey", () => {
  it("daily는 그날 날짜", () => {
    expect(reportPeriodKey("daily", fri)).toBe("2026-10-02");
  });

  it("weekly는 그 주 월요일 날짜 — 일요일도 앞 월요일 주에 든다", () => {
    expect(reportPeriodKey("weekly", mon)).toBe("2026-10-05");
    expect(reportPeriodKey("weekly", new Date(2026, 9, 6, 23, 0))).toBe("2026-10-05");
    expect(reportPeriodKey("weekly", new Date(2026, 9, 11, 22, 0))).toBe("2026-10-05");
  });
});

describe("보고 발송 기록", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "sent-"));

  it("기록이 없으면 안 보낸 것으로 본다", () => {
    const sent = loadSentReports(join(dir(), "none.json"));
    expect(alreadySent(sent, "daily", fri)).toBe(false);
  });

  it("보낸 뒤 같은 날 예비 실행은 건너뛰고, 다음 날은 다시 보낸다", () => {
    const path = join(dir(), "sent.json");
    markSent(path, loadSentReports(path), "daily", fri);
    const reloaded = loadSentReports(path);
    expect(alreadySent(reloaded, "daily", new Date(2026, 9, 2, 9, 10))).toBe(true);
    expect(alreadySent(reloaded, "daily", new Date(2026, 9, 3, 8, 10))).toBe(false);
  });

  it("매일 보고를 보냈다고 주간 보고까지 건너뛰지 않는다", () => {
    const path = join(dir(), "sent.json");
    markSent(path, loadSentReports(path), "daily", mon);
    expect(alreadySent(loadSentReports(path), "weekly", mon)).toBe(false);
  });

  it("깨진 기록은 새로 시작한다 (보내는 쪽으로)", () => {
    const path = join(dir(), "broken.json");
    writeFileSync(path, "{not json", "utf8");
    expect(alreadySent(loadSentReports(path), "weekly", mon)).toBe(false);
  });
});
