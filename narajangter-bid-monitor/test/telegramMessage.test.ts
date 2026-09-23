import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_CHARS,
  buildDocumentCaption,
  buildDocumentFilename,
  buildTelegramFailureMessage,
  buildTelegramMessages,
  escapeTelegramHtml,
  packIntoMessages,
  tallyReport,
} from "../src/notify/telegramMessage.js";
import type { ReportInput } from "../src/report/buildReport.js";
import type { MatchedNotice } from "../src/matching/types.js";
import type { NormalizedNotice } from "../src/api/types.js";

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
    detailUrl: "https://www.g2b.go.kr/detail?no=1&type=a",
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: "협상에 의한 계약",
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

function makeInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const now = new Date("2026-09-17T09:00:00+09:00");
  return {
    generatedAt: now,
    window: { begin: new Date("2026-09-10T00:00:00+09:00"), end: now },
    bid: { matches: [makeMatch()], failures: [] },
    preStandard: { matches: [], failures: [] },
    ...overrides,
  };
}

const FETCH_FAILURE = {
  businessType: "물품" as const,
  notices: [],
  failed: true,
  errorMessage: "타임아웃",
};

describe("escapeTelegramHtml", () => {
  it("텔레그램이 해석하는 &, <, > 만 이스케이프한다", () => {
    expect(escapeTelegramHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("작은따옴표는 그대로 둔다 (텔레그램은 &#39; 엔티티를 지원하지 않아 그대로 노출되기 때문)", () => {
    expect(escapeTelegramHtml("it's")).toBe("it's");
  });

  it("& 를 먼저 치환해 이중 이스케이프가 생기지 않는다", () => {
    expect(escapeTelegramHtml("<b>")).toBe("&lt;b&gt;");
  });
});

describe("tallyReport", () => {
  it("추천등급별·구분별 건수를 센다", () => {
    const input = makeInput({
      bid: {
        matches: [makeMatch(), makeMatch({ confidence: "참고용" })],
        failures: [],
      },
      preStandard: { matches: [makeMatch({ confidence: "참고용" })], failures: [] },
    });
    expect(tallyReport(input)).toEqual({
      total: 3,
      priority: 1,
      brief: 2,
      bid: 2,
      preStandard: 1,
    });
  });
});

describe("buildTelegramMessages — 요약", () => {
  it("첫 메시지에 전체/등급별/구분별 건수를 담는다", () => {
    const summary = buildTelegramMessages(makeInput())[0]!;
    expect(summary).toContain("공고 <b>1건</b>이 확인되었습니다");
    expect(summary).toContain("강력추천 <b>1건</b>");
    expect(summary).toContain("참고용 <b>0건</b>");
    expect(summary).toContain("본공고 1건 · 사전규격 0건");
  });

  it("매칭이 0건이면 없다고 명시한다", () => {
    const input = makeInput({ bid: { matches: [], failures: [] } });
    expect(buildTelegramMessages(input)[0]).toContain("조건에 맞는 공고가 <b>없습니다.</b>");
  });

  it("조회 실패가 있으면 요약에 경고를 넣는다", () => {
    const input = makeInput({ bid: { matches: [makeMatch()], failures: [FETCH_FAILURE] } });
    expect(buildTelegramMessages(input)[0]).toContain("일부 조회 실패");
  });

  it("매칭 0건이어도 조회 실패 경고는 남긴다 (0건과 조회 실패는 전혀 다른 상황이다)", () => {
    const input = makeInput({ bid: { matches: [], failures: [FETCH_FAILURE] } });
    const summary = buildTelegramMessages(input)[0]!;
    expect(summary).toContain("일부 조회 실패");
    expect(summary).toContain("0건이라고 단정하지 마세요");
  });
});

describe("buildTelegramMessages — 등급별 섹션", () => {
  function twoTierInput(): ReportInput {
    return makeInput({
      bid: {
        matches: [
          makeMatch({ confidence: "강력추천" }),
          makeMatch({
            confidence: "참고용",
            notice: makeNotice({ noticeNo: "R26BK99999999", title: "참고용 공고" }),
          }),
        ],
        failures: [],
      },
    });
  }

  it("강력추천 섹션이 참고용 섹션보다 먼저 온다", () => {
    const joined = buildTelegramMessages(twoTierInput()).join("\n");
    expect(joined).toContain("🔴 강력추천 1건");
    expect(joined).toContain("⚪ 참고용 1건");
    expect(joined.indexOf("🔴 강력추천 1건")).toBeLessThan(joined.indexOf("⚪ 참고용 1건"));
  });

  it("강력추천 항목에는 낙찰방법과 매칭근거를 싣는다", () => {
    const joined = buildTelegramMessages(makeInput()).join("\n");
    expect(joined).toContain("낙찰방법 협상에 의한 계약");
    expect(joined).toContain("🏷");
  });

  it("낙찰방법이 없으면 그 줄 자체를 빼둔다", () => {
    const input = makeInput({
      bid: { matches: [makeMatch({ notice: makeNotice({ bidMethod: null }) })], failures: [] },
    });
    expect(buildTelegramMessages(input).join("\n")).not.toContain("낙찰방법");
  });

  it("공동수급 조회 값이 있으면 강력추천 항목에 표시한다", () => {
    const input = makeInput({
      bid: { matches: [makeMatch({ jointBidStatus: "(전자)분담이행" })], failures: [] },
    });
    expect(buildTelegramMessages(input).join("\n")).toContain("🤝 공동수급 (전자)분담이행");
  });

  it("공동수급 조회를 안 했거나 실패했으면(필드 없음) 그 줄 자체를 빼둔다", () => {
    const input = makeInput({ bid: { matches: [makeMatch()], failures: [] } });
    expect(buildTelegramMessages(input).join("\n")).not.toContain("공동수급");
  });

  it("참고용 항목은 압축해 낙찰방법·매칭근거를 싣지 않는다", () => {
    const input = makeInput({
      bid: { matches: [makeMatch({ confidence: "참고용" })], failures: [] },
    });
    const joined = buildTelegramMessages(input).join("\n");
    expect(joined).not.toContain("낙찰방법");
    expect(joined).not.toContain("🏷");
  });

  it("상세 URL이 있으면 제목을 링크로 만든다", () => {
    const joined = buildTelegramMessages(makeInput()).join("\n");
    expect(joined).toContain('<a href="https://www.g2b.go.kr/detail?no=1&amp;type=a">');
  });

  it("상세 URL이 없으면 링크 대신 굵은 글씨로 낸다", () => {
    const input = makeInput({
      bid: { matches: [makeMatch({ notice: makeNotice({ detailUrl: null }) })], failures: [] },
    });
    const joined = buildTelegramMessages(input).join("\n");
    expect(joined).not.toContain("<a href=");
    expect(joined).toContain("<b>정선군 복합문화센터 공간디자인 및 전시물 제작 설치</b>");
  });

  it("몽골 해외의심 플래그를 표시한다", () => {
    const input = makeInput({
      bid: {
        matches: [makeMatch({ overseasVenueFlag: { matchedMongoliaKeyword: "울란바토르" } })],
        failures: [],
      },
    });
    expect(buildTelegramMessages(input).join("\n")).toContain("해외의심(몽골: 울란바토르)");
  });

  it("매칭이 있으면 첨부 파일 안내를 붙인다", () => {
    expect(buildTelegramMessages(makeInput()).join("\n")).toContain("첨부된 HTML 파일");
  });
});

describe("buildTelegramMessages — 길이 제한", () => {
  it("모든 메시지가 텔레그램 상한 이하다", () => {
    const manyMatches = Array.from({ length: 80 }, (_, i) =>
      makeMatch({ notice: makeNotice({ noticeNo: `R26BK0169${i}`, title: `공고 ${i} `.repeat(10) }) })
    );
    const messages = buildTelegramMessages(makeInput({ bid: { matches: manyMatches, failures: [] } }));
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) {
      expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
  });

  it("제목이 지나치게 길어도 카드 하나가 상한을 넘지 않는다", () => {
    const input = makeInput({
      bid: { matches: [makeMatch({ notice: makeNotice({ title: "가".repeat(5000) }) })], failures: [] },
    });
    for (const m of buildTelegramMessages(input)) {
      expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
  });
});

describe("packIntoMessages", () => {
  it("상한에 맞춰 블록을 나눠 담는다", () => {
    const blocks = ["a".repeat(60), "b".repeat(60), "c".repeat(60)];
    expect(packIntoMessages(blocks, 130)).toEqual([
      `${"a".repeat(60)}\n\n${"b".repeat(60)}`,
      "c".repeat(60),
    ]);
  });

  it("블록 하나가 상한을 넘으면 태그를 벗겨 평문으로 자른다 (열린 태그로 끝나면 텔레그램이 400을 낸다)", () => {
    const [only] = packIntoMessages([`<a href="x">${"가".repeat(100)}</a>`], 50);
    expect(only!.length).toBeLessThanOrEqual(50);
    expect(only).not.toContain("<a");
  });

  it("빈 배열이면 빈 배열을 돌려준다", () => {
    expect(packIntoMessages([])).toEqual([]);
  });
});

describe("첨부 파일", () => {
  it("파일명에 날짜를 넣어 대화방에 쌓여도 구분되게 한다", () => {
    expect(buildDocumentFilename(makeInput())).toBe("입찰공고_20260917.html");
  });

  it("캡션에 전체 건수와 강력추천 건수를 담는다", () => {
    expect(buildDocumentCaption(makeInput())).toContain("전체 1건 / 강력추천 1건");
  });
});

describe("buildTelegramFailureMessage", () => {
  it("오류 내용을 <pre>로 감싸고 HTML을 이스케이프한다", () => {
    const message = buildTelegramFailureMessage("<script>alert(1)</script> 실패", new Date());
    expect(message).toContain("<pre>");
    expect(message).toContain("&lt;script&gt;");
    expect(message).not.toContain("<script>");
  });

  it("아주 긴 스택트레이스도 상한 이하로 줄인다", () => {
    const message = buildTelegramFailureMessage("x".repeat(10000), new Date());
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});
