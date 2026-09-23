import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/loadJsonConfig.js";
import { evaluateNotice } from "../src/matching/matchEngine.js";
import type { NormalizedNotice } from "../src/api/types.js";

/**
 * 실측 오탐 회귀 테스트 (2026-09-23).
 *
 * codes.json의 세부품명 '카운터'(5612100201)는 전시 카운터용으로 보유한 코드인데,
 * 은행 창구 카운터에도 이름이 겹쳐서 매칭됐다. 30일치 매칭에서 중소기업은행 6개 지점의
 * "OO지점 전체 레이아웃 가구 제작설치" 공고가 전부 이 코드 단독 매칭(키워드 매칭 없음)으로
 * 통과했다. config/keywords.json에 '레이아웃 가구' 제외어를 추가해 막았다.
 *
 * 실제 config 파일(keywords.json + codes.json)을 그대로 로드해서 검사한다 — mock config로는
 * 이 회귀를 재현할 수 없다. '카운터' 코드 자체는 지일이 실제로 보유하고 있어 지우면 안 되고,
 * 문제는 제외 키워드 쪽에서 막아야 하기 때문이다.
 */

const config = loadAppConfig();

function bidNotice(overrides: Partial<NormalizedNotice>): NormalizedNotice {
  return {
    noticeNo: "TEST-0001",
    title: "테스트 공고",
    institution: "테스트기관",
    businessType: "물품",
    sourceType: "본공고",
    postedAt: "20260901",
    deadline: "20260930",
    budgetAmount: 100_000_000,
    detailUrl: "https://example.com",
    industryText: null,
    productClsfcNo: "5612100201", // 카운터 — 지일 보유 코드, 이 코드만으로 은행 가구가 걸렸다
    productClsfcName: "카운터",
    bidMethod: null,
    raw: {},
    ...overrides,
  };
}

describe("은행 지점 가구 오탐 — 실제 config로 검증", () => {
  it("카운터 코드는 지일이 실제로 보유하고 있다 (전제 조건)", () => {
    const held = [...config.heldProducts, ...config.heldIndustries];
    expect(held.some((c) => c.code === "5612100201" && c.name === "카운터")).toBe(true);
  });

  it("실측된 은행 지점 공고 6건이 전부 제외된다", () => {
    const titles = [
      "하남풍산지점 전체 레이아웃 가구 제작설치",
      "호계동지점 전체 레이아웃 가구 제작설치",
      "인천지점 전체 레이아웃 가구 제작설치",
      "파주지점 전체 레이아웃 가구 제작설치",
      "춘의테크노지점 전체 레이아웃 가구 제작설치",
      "광명지점 전체 레이아웃 가구 제작설치",
    ];
    for (const title of titles) {
      const result = evaluateNotice(bidNotice({ title, institution: "중소기업은행" }), config);
      expect(result, `"${title}"은 제외되어야 한다`).toBeNull();
    }
  });

  it("'레이아웃 가구'가 없는 카운터 공고까지 과도하게 막지는 않는다 (과제외 방지)", () => {
    // 지일 실적처럼 '카운터'만 단독으로 걸리는 전시 공고는 계속 통과해야 한다.
    const result = evaluateNotice(
      bidNotice({ title: "국립OO과학관 안내데스크 카운터 제작설치", institution: "국립OO과학관" }),
      config
    );
    expect(result).not.toBeNull();
  });

  it("지일 실제 가구 실적과 같은 패턴의 문구는 걸리지 않는다 (과제외 방지)", () => {
    // 코퍼스에 실제로 있는 지일 실적 문구 패턴: "OO 공간디자인 및 시설, 가구 제작·설치",
    // "OO 디자인가구 제작·설치" — '레이아웃'이라는 단어 자체를 쓰지 않는다.
    const titles = [
      "OO도서관 공간구성 및 디자인가구 제작설치",
      "OO 인재발전소 공간디자인 및 시설, 가구 제작·설치 사업",
      "OO 에듀케어 플랫폼 디자인가구 제작·설치",
    ];
    for (const title of titles) {
      const result = evaluateNotice(bidNotice({ title }), config);
      expect(result, `"${title}"은 통과해야 한다`).not.toBeNull();
    }
  });
});
