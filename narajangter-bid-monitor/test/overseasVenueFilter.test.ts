import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import {
  _resetMongoliaKeywordsCacheForTests,
  detectOverseasVenue,
  loadMongoliaKeywords,
} from "../src/matching/overseasVenueFilter.js";
import { OVERSEAS_VENUE_SAMPLES } from "./fixtures/overseasVenueSamples.js";

// 표본 8건에는 몽골 관련 공고가 없으므로, 표본 검증에는 몽골 키워드가 필요 없다
// (몽골 예외 분기 자체는 아래 별도 테스트에서 확인한다).
const NO_MONGOLIA_KEYWORDS: string[] = [];

describe("detectOverseasVenue — 표본 8건 재현", () => {
  it.each(OVERSEAS_VENUE_SAMPLES)("$noticeNo: $title", ({ title, expectedOverseasVenue }) => {
    const result = detectOverseasVenue(title, NO_MONGOLIA_KEYWORDS);
    expect(result.isOverseasVenue).toBe(expectedOverseasVenue);
    // 표본에 몽골 케이스가 없으므로 자동배제 여부는 매칭 여부와 항상 같아야 한다.
    expect(result.shouldAutoExclude).toBe(expectedOverseasVenue);
  });

  it("표본 8건 전체 기준 재현율/정밀도가 100%다", () => {
    const results = OVERSEAS_VENUE_SAMPLES.map((sample) => ({
      sample,
      actual: detectOverseasVenue(sample.title, NO_MONGOLIA_KEYWORDS).isOverseasVenue,
    }));

    const positives = results.filter((r) => r.sample.expectedOverseasVenue);
    const truePositives = positives.filter((r) => r.actual).length;
    const falsePositives = results.filter((r) => !r.sample.expectedOverseasVenue && r.actual).length;

    expect(truePositives).toBe(positives.length); // 재현율 100%
    expect(falsePositives).toBe(0); // 정밀도 100% (오탐 없음)
  });
});

describe("detectOverseasVenue — 몽골 예외 분기", () => {
  it("몽골 키워드가 함께 있으면 매칭되어도 자동배제하지 않는다", () => {
    const result = detectOverseasVenue("2026 몽골 울란바토르 국제무역박람회 한국관 설치 용역", [
      "몽골",
      "울란바토르",
    ]);
    expect(result.isOverseasVenue).toBe(true);
    expect(result.isMongolia).toBe(true);
    expect(result.matchedMongoliaKeyword).toBe("몽골");
    expect(result.shouldAutoExclude).toBe(false);
  });

  it("몽골 키워드가 없으면 매칭 시 자동배제 대상이다", () => {
    const result = detectOverseasVenue("2026 베트남 하노이 소비재박람회 한국관 설치 용역", ["몽골", "울란바토르"]);
    expect(result.isMongolia).toBe(false);
    expect(result.shouldAutoExclude).toBe(true);
  });

  it("한글 키워드가 전혀 없으면 매칭되지 않는다 (구조적 한계 — ⑦ 피드백이 안전망)", () => {
    const result = detectOverseasVenue("HLTH USA", []);
    expect(result.isOverseasVenue).toBe(false);
    expect(result.shouldAutoExclude).toBe(false);
  });
});

describe("loadMongoliaKeywords", () => {
  const originalDir = process.env.APP_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.APP_CONFIG_DIR;
    _resetMongoliaKeywordsCacheForTests();
  });

  afterEach(() => {
    if (originalDir) process.env.APP_CONFIG_DIR = originalDir;
    else delete process.env.APP_CONFIG_DIR;
    _resetMongoliaKeywordsCacheForTests();
  });

  function writeConfigDir(data: unknown): string {
    const dir = mkdtempSync(path.join(tmpdir(), "narajangter-overseas-test-"));
    writeFileSync(path.join(dir, "overseas-venue-keywords.json"), JSON.stringify(data));
    return dir;
  }

  it("정상 설정 파일을 로드한다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({ mongoliaKeywords: ["몽골", "울란바토르"] });
    expect(loadMongoliaKeywords()).toEqual(["몽골", "울란바토르"]);
  });

  it("mongoliaKeywords가 비어있으면 ConfigError를 던진다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({ mongoliaKeywords: [] });
    expect(() => loadMongoliaKeywords()).toThrow(ConfigError);
  });

  it("실제 레포의 config/overseas-venue-keywords.json을 로드하면 '몽골'을 포함한다", () => {
    delete process.env.APP_CONFIG_DIR; // 프로젝트 루트 config/ 사용
    expect(loadMongoliaKeywords()).toContain("몽골");
  });
});
