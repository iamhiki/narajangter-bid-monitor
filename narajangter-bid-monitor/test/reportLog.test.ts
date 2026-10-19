import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedNotice } from "../src/api/types.js";
import type { MatchedNotice } from "../src/matching/types.js";
import {
  buildReportLog,
  logStatusOf,
  mergeReportLog,
  parseReportLog,
  writeReportLog,
  type ReportedRecord,
  type ReportLogEntry,
} from "../src/state/reportLog.js";

function match(noticeNo: string, overrides: Partial<NormalizedNotice> = {}): MatchedNotice {
  const notice: NormalizedNotice = {
    noticeNo,
    title: `${noticeNo} 전시관 조성`,
    institution: "OO시",
    businessType: "용역",
    sourceType: "본공고",
    postedAt: "2026-10-19 10:00",
    deadline: "2026-10-27 10:00",
    budgetAmount: 300_000_000,
    detailUrl: "https://g2b/x",
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: "협상에의한계약",
    raw: { dminsttNm: "OO과학관" },
    ...overrides,
  } as NormalizedNotice;
  return {
    notice,
    matchedProductCodes: [{ code: "6012100201", name: "조형물" }],
    matchedIndustryCodes: [],
    matchedKeywords: ["전시관"],
    confidence: "강력추천",
    overseasVenueFlag: null,
    similarity: { score: 0.4, shown: 0.716, basis: "제목", top: [] },
  } as MatchedNotice;
}

const entry = (kind: "daily" | "weekly", date: string, ...nos: string[]): ReportLogEntry => ({
  ...buildReportLog(kind, nos.map((n) => match(n)), new Date(`${date}T00:30:00Z`)),
  date,
});

describe("buildReportLog — 보고에 나간 공고 목록", () => {
  it("판단 기록 meta와 같은 모양으로, 공개 공고 정보만 담는다", () => {
    const e = buildReportLog("daily", [match("R1")], new Date("2026-10-19T23:30:00Z"));
    expect(e.date).toBe("2026-10-20"); // 한국 날짜
    expect(e.notices[0]).toEqual({
      noticeNo: "R1",
      title: "R1 전시관 조성",
      meta: {
        sourceType: "본공고",
        businessType: "용역",
        institution: "OO과학관",
        budgetAmount: 300_000_000,
        confidence: "강력추천",
        bidMethod: "협상",
        keywords: ["전시관"],
        products: ["조형물"],
        score: 72,
        deadline: "2026-10-27 10:00",
        detailUrl: "https://g2b/x",
      },
    });
  });

  it("파일 이름은 보고일-종류.json이고, 다시 읽으면 같은 내용이다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "narajangter-reportlog-"));
    const e = entry("weekly", "2026-10-20", "R1", "R2");
    const file = writeReportLog(dir, e);
    expect(path.basename(file)).toBe("2026-10-20-weekly.json");
    expect(parseReportLog(readFileSync(file, "utf8"))).toEqual(e);
  });

  it("모양이 다른 파일은 null — 건너뛴다", () => {
    expect(parseReportLog("not json")).toBeNull();
    expect(parseReportLog(JSON.stringify({ v: 2, kind: "daily", date: "x", notices: [] }))).toBeNull();
    expect(parseReportLog(JSON.stringify({ v: 1, kind: "monthly", date: "x", notices: [] }))).toBeNull();
  });
});

describe("mergeReportLog — 판단 기록에 '미판단'으로 쌓기", () => {
  it("처음 보는 공고는 판단 없이 보고 표시와 공고 정보로 만든다", () => {
    const records: Record<string, ReportedRecord> = {};
    expect(mergeReportLog(records, entry("daily", "2026-10-20", "R1"))).toBe(true);
    expect(records.R1).toMatchObject({ noticeNo: "R1", status: null, owner: "", comments: [], reports: [{ date: "2026-10-20", kind: "daily" }] });
    expect(records.R1!.meta?.institution).toBe("OO과학관");
  });

  it("이미 판단한 공고는 판단·담당·대화·판단 때 공고 정보를 건드리지 않고 보고 표시만 더한다", () => {
    const records: Record<string, ReportedRecord> = {
      R1: { noticeNo: "R1", title: "R1", status: "참가", owner: "김담당", updatedAt: "x", comments: [{ by: "김담당", text: "가자" }], meta: { score: 80 } },
    };
    mergeReportLog(records, entry("weekly", "2026-10-20", "R1"));
    expect(records.R1).toMatchObject({ status: "참가", owner: "김담당", comments: [{ by: "김담당", text: "가자" }], meta: { score: 80 } });
    expect(records.R1!.reports).toEqual([{ date: "2026-10-20", kind: "weekly" }]);
  });

  it("같은 보고를 여러 번 합쳐도 한 번 합친 것과 같다 (바뀐 게 없으면 false)", () => {
    const records: Record<string, ReportedRecord> = {};
    const e = entry("daily", "2026-10-20", "R1", "R2");
    mergeReportLog(records, e);
    const once = JSON.stringify(records);
    expect(mergeReportLog(records, e)).toBe(false);
    expect(JSON.stringify(records)).toBe(once);
  });

  it("매일·주간 보고에 같은 공고가 나오면 한 줄에 보고 표시가 둘 (날짜순)", () => {
    const records: Record<string, ReportedRecord> = {};
    mergeReportLog(records, entry("weekly", "2026-10-27", "R1"));
    mergeReportLog(records, entry("daily", "2026-10-21", "R1"));
    expect(Object.keys(records)).toEqual(["R1"]);
    expect(records.R1!.reports).toEqual([
      { date: "2026-10-21", kind: "daily" },
      { date: "2026-10-27", kind: "weekly" },
    ]);
  });
});

describe("logStatusOf — 판단 기록 탭에 보이는 상태", () => {
  const now = new Date("2026-10-24T03:00:00Z"); // 한국 10/24 12:00
  const reported = { reports: [{ date: "2026-10-20", kind: "daily" as const }] };

  it("참가·보류·불참은 그대로", () => {
    expect(logStatusOf({ status: "보류", ...reported }, now)).toBe("보류");
  });

  it("보고됐고 판단 전이면 마감 전엔 '미판단', 마감이 지났으면 '놓침'", () => {
    expect(logStatusOf({ status: null, ...reported, meta: { deadline: "2026-10-24 13:00" } }, now)).toBe("미판단");
    expect(logStatusOf({ status: null, ...reported, meta: { deadline: "2026-10-24 11:00" } }, now)).toBe("놓침");
    // 시각이 없는 마감은 그날 끝까지
    expect(logStatusOf({ status: null, ...reported, meta: { deadline: "2026-10-24" } }, now)).toBe("미판단");
    // 검토중도 아직 판단 전이다
    expect(logStatusOf({ status: "검토중", ...reported, meta: { deadline: "2026-10-30 10:00" } }, now)).toBe("미판단");
  });

  it("마감을 모르면 '미판단'", () => {
    expect(logStatusOf({ status: null, ...reported }, now)).toBe("미판단");
  });

  it("보고되지 않았고 판단도 없으면 싣지 않는다 (null)", () => {
    expect(logStatusOf({ status: null }, now)).toBeNull();
    expect(logStatusOf({ status: "검토중" }, now)).toBeNull();
  });
});
