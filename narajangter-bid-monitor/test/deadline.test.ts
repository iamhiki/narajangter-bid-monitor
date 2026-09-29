import { describe, expect, it } from "vitest";
import {
  daysUntilDeadline,
  excludeExpiredNotices,
  isDeadlinePassed,
  parseKstDateTime,
  selectClosingSoon,
} from "../src/matching/deadline.js";
import type { NormalizedNotice } from "../src/api/types.js";

function notice(noticeNo: string, deadline: string | null): NormalizedNotice {
  return {
    noticeNo,
    title: "테스트 공고",
    institution: null,
    businessType: "용역",
    sourceType: "본공고",
    postedAt: null,
    deadline,
    budgetAmount: null,
    detailUrl: null,
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: null,
    raw: {},
  };
}

describe("parseKstDateTime", () => {
  it("나라장터 실측 형식을 한국 시각으로 읽는다 (실행 환경 시간대와 무관)", () => {
    // 2026-09-17 10:00 KST = 2026-09-17 01:00 UTC
    expect(parseKstDateTime("2026-09-17 10:00:00")?.toISOString()).toBe("2026-09-17T01:00:00.000Z");
  });

  it("날짜만 있으면 그날 23:59까지로 본다", () => {
    expect(parseKstDateTime("2026-09-17")?.toISOString()).toBe("2026-09-17T14:59:00.000Z");
  });

  it("숫자만 붙은 형식(YYYYMMDDHHMM)도 읽는다", () => {
    expect(parseKstDateTime("202609171000")?.toISOString()).toBe("2026-09-17T01:00:00.000Z");
  });

  it("알아볼 수 없으면 null", () => {
    expect(parseKstDateTime("미정")).toBeNull();
    expect(parseKstDateTime(null)).toBeNull();
  });
});

describe("isDeadlinePassed", () => {
  // 실측 사례: 마감 09-17 10:00 KST 공고가 09-17 18:29 KST에 만든 리포트에 들어 있었다.
  const reportTime = new Date("2026-09-17T09:29:16.094Z");

  it("마감이 지났으면 true", () => {
    expect(isDeadlinePassed("2026-09-17 10:00:00", reportTime)).toBe(true);
  });

  it("마감 전이면 false", () => {
    expect(isDeadlinePassed("2026-10-14 17:00:00", reportTime)).toBe(false);
  });

  it("같은 날이라도 마감 시각 전이면 false (시간대를 UTC로 잘못 읽으면 여기서 틀린다)", () => {
    // 09-17 20:00 KST 마감, 지금은 09-17 18:29 KST
    expect(isDeadlinePassed("2026-09-17 20:00:00", reportTime)).toBe(false);
  });

  it("마감일시가 없거나 형식을 모르면 지우지 않는다 (fail-open)", () => {
    expect(isDeadlinePassed(null, reportTime)).toBe(false);
    expect(isDeadlinePassed("추후 공지", reportTime)).toBe(false);
  });
});

describe("excludeExpiredNotices", () => {
  it("마감 지난 공고만 빼고 몇 건 뺐는지 알려준다", () => {
    const now = new Date("2026-09-17T09:29:16.094Z");
    const { open, expiredCount } = excludeExpiredNotices(
      [notice("A", "2026-09-17 10:00:00"), notice("B", "2026-10-14 17:00:00"), notice("C", null)],
      now
    );
    expect(open.map((n) => n.noticeNo)).toEqual(["B", "C"]);
    expect(expiredCount).toBe(1);
  });
});

describe("selectClosingSoon / daysUntilDeadline (매일 마감 임박 보고)", () => {
  const now = new Date("2026-09-29T08:10:00+09:00");
  const wrap = (n: NormalizedNotice) => ({ notice: n });

  it("D-7 이내(오후 마감 포함)만 마감 빠른 순으로 고른다", () => {
    const picked = selectClosingSoon(
      [
        wrap(notice("late", "2026-10-06 17:00:00")),
        wrap(notice("soon", "2026-09-30 10:00:00")),
        wrap(notice("past", "2026-09-29 08:00:00")), // 이미 마감
        wrap(notice("far", "2026-10-07 10:00:00")), // D-8
        wrap(notice("unknown", null)), // 마감 모름 — 넣을 근거가 없다
      ],
      now
    );
    expect(picked.map((m) => m.notice.noticeNo)).toEqual(["soon", "late"]);
  });

  it("D-day는 한국 달력 기준으로 센다", () => {
    expect(daysUntilDeadline("2026-09-29 17:00:00", now)).toBe(0);
    expect(daysUntilDeadline("2026-09-30 00:30:00", now)).toBe(1);
    expect(daysUntilDeadline("2026-10-06 17:00:00", now)).toBe(7);
    expect(daysUntilDeadline(null, now)).toBeNull();
  });
});
