import { describe, expect, it } from "vitest";
import { attachSimilarity } from "../src/pipeline.js";
import {
  formatSimilarProjects,
  sanitizeCell,
  FEEDBACK_HEADER,
  SYSTEM_COLUMN_COUNT,
  toFeedbackRow,
} from "../src/sheets/feedbackRow.js";
import { similarityLine } from "../src/notify/telegramMessage.js";
import type { MatchedNotice } from "../src/matching/types.js";
import type { NormalizedNotice } from "../src/api/types.js";

function notice(title: string): NormalizedNotice {
  return {
    noticeNo: "R26TEST0001",
    title,
    institution: "정선군",
    businessType: "용역",
    sourceType: "본공고",
    postedAt: "2026-09-01",
    deadline: "2026-09-30",
    budgetAmount: 350_000_000,
    detailUrl: "https://example.test/notice",
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: null,
  } as NormalizedNotice;
}

function matched(title: string, similarity?: MatchedNotice["similarity"]): MatchedNotice {
  return {
    notice: notice(title),
    matchedProductCodes: [],
    matchedIndustryCodes: [],
    matchedKeywords: ["전시관"],
    confidence: "참고용",
    overseasVenueFlag: null,
    ...(similarity ? { similarity } : {}),
  };
}

describe("피드백 시트 열 구성", () => {
  it("싱크로율 열이 시스템 구간 안에 있고 담당자 입력란보다 앞이다", () => {
    // 담당자 입력란(판정~판정일)을 덮어쓰지 않으려면 시스템 열이 앞쪽에 몰려 있어야 한다.
    const sync = FEEDBACK_HEADER.indexOf("싱크로율");
    const rawScore = FEEDBACK_HEADER.indexOf("원점수");
    const basis = FEEDBACK_HEADER.indexOf("싱크로율근거");
    const similar = FEEDBACK_HEADER.indexOf("유사 과거사업");
    const verdict = FEEDBACK_HEADER.indexOf("판정");
    expect(sync).toBeGreaterThanOrEqual(0);
    // 표시값 → 원점수 → 근거 → 유사사업 순으로 붙어 있어야 담당자가 한눈에 읽는다.
    expect(rawScore).toBe(sync + 1);
    expect(basis).toBe(rawScore + 1);
    expect(similar).toBe(basis + 1);
    // 담당자 입력란은 시스템 열 바로 뒤에서 시작해야 한다.
    expect(verdict).toBe(SYSTEM_COLUMN_COUNT);
    expect(similar).toBeLessThan(verdict);
  });

  it("행 길이가 시스템 열 개수와 정확히 같다", () => {
    // feedbackSheet.ts가 이 값이 어긋나면 담당자 입력란 훼손으로 보고 중단한다.
    expect(toFeedbackRow(matched("전시관 조성"), new Date())).toHaveLength(SYSTEM_COLUMN_COUNT);
  });

  it("코퍼스가 없어 싱크로율을 못 구했으면 0이 아니라 빈 칸으로 남긴다", () => {
    // 0은 "안 비슷하다", 빈 칸은 "비교할 자료가 없다" — 뜻이 다르다.
    const row = toFeedbackRow(matched("전시관 조성"), new Date());
    expect(row[FEEDBACK_HEADER.indexOf("싱크로율")]).toBe("");
    expect(row[FEEDBACK_HEADER.indexOf("유사 과거사업")]).toBe("");
  });

  it("싱크로율이 있으면 숫자로 넣는다 (시트 정렬·필터용)", () => {
    const row = toFeedbackRow(
      matched("전시관 조성", { score: 0.4973, shown: 0.72, basis: "제목" as const, top: [{ id: "2023/x", name: "평화테마파크", year: 2023, score: 0.4973 }] }),
      new Date()
    );
    expect(row[FEEDBACK_HEADER.indexOf("싱크로율")]).toBe(72);   // 보정 표시값(%)
    expect(row[FEEDBACK_HEADER.indexOf("원점수")]).toBe(0.4973); // 원점수도 보존
    expect(row[FEEDBACK_HEADER.indexOf("유사 과거사업")]).toContain("평화테마파크");
  });
});

describe("sanitizeCell", () => {
  it("수식으로 해석되는 4개 문자만 따옴표를 붙인다", () => {
    for (const v of ["=SUM(A1)", "+1", "-1", "@user"]) {
      expect(sanitizeCell(v)).toBe(`'${v}`);
    }
  });

  it("숫자로 시작하는 값을 훼손하지 않는다", () => {
    // 이전 정규식 /^[=+-@]/ 는 `+-@`가 문자 범위(0x2B~0x40)로 읽혀 숫자·쉼표·마침표까지
    // 22개 문자를 잡았다. 그래서 마감일이 강제 텍스트가 되어 시트 날짜 정렬이 깨졌다.
    expect(sanitizeCell("2026-09-30")).toBe("2026-09-30");
    expect(sanitizeCell("2026. 충북과학체험관 전시체험물 개선")).toBe("2026. 충북과학체험관 전시체험물 개선");
    expect(sanitizeCell("2023 평화테마파크 (0.497)")).toBe("2023 평화테마파크 (0.497)");
    expect(sanitizeCell("1,000,000")).toBe("1,000,000");
  });

  it("마감일이 시트에서 날짜로 남는다", () => {
    const row = toFeedbackRow(matched("전시관 조성"), new Date());
    expect(row[FEEDBACK_HEADER.indexOf("마감")]).not.toMatch(/^'/);
  });
});

describe("formatSimilarProjects", () => {
  it("연도·이름·점수를 함께 적는다", () => {
    const text = formatSimilarProjects(
      matched("x", { score: 0.5, shown: 0.70, basis: "제목" as const, top: [{ id: "a", name: "평화테마파크", year: 2023, score: 0.5 }] })
    );
    expect(text).toBe("2023 평화테마파크 (0.500)");
  });

  it("거의 안 겹치는 항목은 버린다", () => {
    const text = formatSimilarProjects(
      matched("x", {
        score: 0.5,
        shown: 0.7,
        basis: "제목" as const,
        top: [
          { id: "a", name: "평화테마파크", year: 2023, score: 0.5 },
          { id: "b", name: "무관사업", year: 2022, score: 0.01 },
        ],
      })
    );
    expect(text).toContain("평화테마파크");
    expect(text).not.toContain("무관사업");
  });

  it("싱크로율이 없으면 빈 문자열", () => {
    expect(formatSimilarProjects(matched("x"))).toBe("");
  });
});

describe("similarityLine (텔레그램)", () => {
  it("퍼센트와 가장 비슷한 사업을 보여준다", () => {
    const line = similarityLine(matched("x", { score: 0.497, shown: 0.72, basis: "제목" as const, top: [{ id: "a", name: "평화테마파크", year: 2023, score: 0.497 }] }));
    expect(line).toContain("72%");
    expect(line).toContain("평화테마파크");
  });

  it("코퍼스가 없으면 줄 자체를 만들지 않는다", () => {
    expect(similarityLine(matched("x"))).toBeNull();
  });
});

describe("attachSimilarity", () => {
  it("코퍼스가 없는 환경에서도 예외 없이 지나간다", () => {
    // GitHub Actions에는 data/past-projects.json이 없다. 주간 리포트가 여기서 죽으면 안 된다.
    const matches = [matched("전시관 조성")];
    expect(() => attachSimilarity(matches)).not.toThrow();
    // 코퍼스가 있는 로컬에서는 채워지고, 없으면 그대로 비어 있다 — 둘 다 정상이다.
    if (matches[0]?.similarity) {
      expect(matches[0].similarity.score).toBeGreaterThanOrEqual(0);
      expect(matches[0].similarity.score).toBeLessThanOrEqual(1);
    }
  });
});
