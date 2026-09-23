import { describe, expect, it } from "vitest";
import {
  FEEDBACK_HEADER,
  SYSTEM_COLUMN_COUNT,
  formatMatchReason,
  sanitizeCell,
  selectNewRows,
  toFeedbackRow,
} from "../src/sheets/feedbackRow.js";
import type { MatchedNotice } from "../src/matching/types.js";
import type { NormalizedNotice } from "../src/api/types.js";

const COLLECTED_AT = new Date("2026-09-17T09:05:00+09:00");

function makeNotice(overrides: Partial<NormalizedNotice> = {}): NormalizedNotice {
  return {
    noticeNo: "R26BK01695832",
    title: "정선군 복합문화센터 공간디자인 및 전시물 제작 설치",
    institution: "정선군",
    businessType: "용역",
    sourceType: "본공고",
    postedAt: null,
    deadline: "2026-10-01",
    budgetAmount: 350000000,
    detailUrl: "https://www.g2b.go.kr/detail",
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: "협상에의한계약-협상에 의한 낙찰자 결정",
    raw: {},
    ...overrides,
  };
}

function makeMatch(overrides: Partial<MatchedNotice> = {}): MatchedNotice {
  return {
    notice: makeNotice(),
    matchedProductCodes: [{ code: "6010989901", name: "실물모형및전시물" }],
    matchedIndustryCodes: [],
    matchedKeywords: ["전시"],
    confidence: "강력추천",
    overseasVenueFlag: null,
    ...overrides,
  };
}

describe("FEEDBACK_HEADER", () => {
  it("담당자 입력란(판정/오판사유/판정자/판정일)이 시스템 열 뒤에 온다", () => {
    expect(FEEDBACK_HEADER.slice(SYSTEM_COLUMN_COUNT)).toEqual([
      "판정",
      "오판사유",
      "판정자",
      "판정일",
    ]);
  });

  it("규칙 개선의 근거가 되는 '매칭근거' 열이 시스템 열 안에 있다", () => {
    expect(FEEDBACK_HEADER.indexOf("매칭근거")).toBeGreaterThanOrEqual(0);
    expect(FEEDBACK_HEADER.indexOf("매칭근거")).toBeLessThan(SYSTEM_COLUMN_COUNT);
  });
});

describe("sanitizeCell", () => {
  it.each(["=SUM(A1:A2)", "+1", "-1", "@user"])(
    "'%s'처럼 수식으로 해석될 값 앞에 작은따옴표를 붙인다",
    (value) => {
      expect(sanitizeCell(value)).toBe(`'${value}`);
    }
  );

  it("평범한 문자열은 그대로 둔다", () => {
    expect(sanitizeCell("정선군 복합문화센터")).toBe("정선군 복합문화센터");
  });
});

describe("formatMatchReason", () => {
  it("품목·업종·키워드 매칭을 코드까지 포함해 한 칸에 적는다", () => {
    const reason = formatMatchReason(
      makeMatch({
        matchedProductCodes: [{ code: "6010989901", name: "실물모형및전시물" }],
        matchedIndustryCodes: [{ code: "4990", name: "실내건축공사업" }],
        matchedKeywords: ["전시", "박물관"],
      })
    );
    expect(reason).toBe(
      "품목 실물모형및전시물(6010989901) / 업종 실내건축공사업(4990) / 키워드 전시 / 키워드 박물관"
    );
  });

  it("매칭 근거가 하나도 없으면 빈 칸 대신 표시를 남긴다", () => {
    const reason = formatMatchReason(
      makeMatch({ matchedProductCodes: [], matchedIndustryCodes: [], matchedKeywords: [] })
    );
    expect(reason).toBe("(근거 없음)");
  });
});

describe("toFeedbackRow", () => {
  it("시스템 열 개수만큼만 만든다 (담당자 입력란을 덮어쓰지 않도록)", () => {
    expect(toFeedbackRow(makeMatch(), COLLECTED_AT)).toHaveLength(SYSTEM_COLUMN_COUNT);
  });

  it("예산은 숫자로 넣어 시트에서 정렬·합계가 되게 한다", () => {
    expect(toFeedbackRow(makeMatch(), COLLECTED_AT)[5]).toBe(350000000);
  });

  it("예산 미상이면 0이 아니라 빈 칸으로 둔다 (0원 공고와 구분되어야 함)", () => {
    const row = toFeedbackRow(
      makeMatch({ notice: makeNotice({ budgetAmount: null }) }),
      COLLECTED_AT
    );
    expect(row[5]).toBe("");
  });

  it("몽골 해외의심 플래그를 기록한다", () => {
    const row = toFeedbackRow(
      makeMatch({ overseasVenueFlag: { matchedMongoliaKeyword: "울란바토르" } }),
      COLLECTED_AT
    );
    expect(row[10]).toBe("몽골: 울란바토르");
  });

  it("수식으로 시작하는 공고명은 텍스트로 강제한다", () => {
    const row = toFeedbackRow(
      makeMatch({ notice: makeNotice({ title: "=위험한제목" }) }),
      COLLECTED_AT
    );
    expect(row[3]).toBe("'=위험한제목");
  });

  it("수집일시를 사람이 읽는 형식으로 넣는다", () => {
    expect(toFeedbackRow(makeMatch(), COLLECTED_AT)[12]).toBe("2026-09-17 09:05");
  });

  it("공동수급방식 조회 값을 그대로 넣는다", () => {
    const row = toFeedbackRow(makeMatch({ jointBidStatus: "(없음)공동수급불허" }), COLLECTED_AT);
    expect(row[FEEDBACK_HEADER.indexOf("공동수급방식")]).toBe("(없음)공동수급불허");
  });

  it("조회를 안 했거나 실패했으면 빈 칸 (0/불허와 구분)", () => {
    const row = toFeedbackRow(makeMatch(), COLLECTED_AT);
    expect(row[FEEDBACK_HEADER.indexOf("공동수급방식")]).toBe("");
  });
});

describe("selectNewRows", () => {
  it("이미 시트에 있는 공고번호는 건너뛴다", () => {
    const matches = [
      makeMatch({ notice: makeNotice({ noticeNo: "A1" }) }),
      makeMatch({ notice: makeNotice({ noticeNo: "A2" }) }),
    ];
    const { rows, skipped } = selectNewRows(matches, ["A1"], COLLECTED_AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe("A2");
    expect(skipped).toBe(1);
  });

  it("같은 실행 안에서 중복된 공고번호도 한 번만 넣는다", () => {
    const matches = [
      makeMatch({ notice: makeNotice({ noticeNo: "A1" }) }),
      makeMatch({ notice: makeNotice({ noticeNo: "A1" }) }),
    ];
    const { rows, skipped } = selectNewRows(matches, [], COLLECTED_AT);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("전부 이미 있으면 빈 배열을 돌려준다 (조회 기간이 실행 주기보다 길 때의 정상 동작)", () => {
    const matches = [makeMatch({ notice: makeNotice({ noticeNo: "A1" }) })];
    expect(selectNewRows(matches, ["A1"], COLLECTED_AT).rows).toEqual([]);
  });

  it("매칭이 0건이면 아무것도 만들지 않는다", () => {
    expect(selectNewRows([], ["A1"], COLLECTED_AT)).toEqual({ rows: [], skipped: 0 });
  });
});
