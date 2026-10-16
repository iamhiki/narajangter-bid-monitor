import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import {
  _resetMongoliaKeywordsCacheForTests,
  detectOverseasVenue,
  loadMongoliaKeywords,
  loadOverseasRules,
  type OverseasRules,
} from "../src/matching/overseasVenueFilter.js";
import { OVERSEAS_VENUE_SAMPLES } from "./fixtures/overseasVenueSamples.js";

// 표본 8건에는 몽골 관련 공고가 없으므로, 표본 검증에는 몽골 키워드가 필요 없다
// (몽골 예외 분기 자체는 아래 별도 테스트에서 확인한다).
const NO_MONGOLIA_KEYWORDS: string[] = [];
const RULES: OverseasRules = {
  overseasPlaces: ["두바이", "도쿄", "UAE", "TOKYO", "ASIA", "NEW YORK"],
  countryAbbreviations: ["USA", "UAE", "UK"],
};

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

  it("몽골 키워드가 있으면 국가 약자·지명 규칙으로 걸려도 자동배제하지 않는다", () => {
    const result = detectOverseasVenue("몽골 울란바토르 USA 공동 한국관 조성", ["몽골"], RULES);
    expect(result.isOverseasVenue).toBe(true);
    expect(result.shouldAutoExclude).toBe(false);
  });
});

describe("detectOverseasVenue — 한국관 단독 (2026-10-16)", () => {
  it.each([
    "2026 RISCON TOKYO 통합한국관 부스장치 설치 용역",
    "2026 RISCON TOKYO통합한국관 행사운영 용역",
    "CES 2027 통합한국관 조성운영 위탁용역",
    "NANO TECH 2027 한국관 장치/조성 용역업체 선정",
    "Obesity Week 2026 한국관 구축 용역",
    "HLTH USA 2026 디지털헬스케어 한국관 설치 및 운영",
  ])("%s", (title) => {
    const result = detectOverseasVenue(title, NO_MONGOLIA_KEYWORDS, RULES);
    expect(result.shouldAutoExclude).toBe(true);
    expect(result.reason).toContain("한국관");
  });

  it("한국관광고·한국관리공단처럼 다른 낱말로 이어지면 빼지 않는다", () => {
    for (const title of ["한국관광고 체육관 및 급식소 증축공사", "2027학년도 한국관광고등학교 교복 학교주관구매", "한국관리공단 홍보관 조성"]) {
      expect(detectOverseasVenue(title, NO_MONGOLIA_KEYWORDS, RULES).isOverseasVenue).toBe(false);
    }
  });
});

describe("detectOverseasVenue — 단체관 (전시회류 또는 해외 지명과 함께)", () => {
  it("전시회·박람회와 함께면 뺀다", () => {
    const result = detectOverseasVenue("2026 홍콩 코스모프로프 뷰티 전시회 단체관 전시디자인 및 설치용역", NO_MONGOLIA_KEYWORDS, RULES);
    expect(result.shouldAutoExclude).toBe(true);
    expect(result.reason).toContain("단체관");
  });

  it("해외 지명과 함께면 뺀다 — 영문 지명은 대소문자 무시", () => {
    expect(detectOverseasVenue("두바이 의료기기 단체관 설치", NO_MONGOLIA_KEYWORDS, RULES).reason).toContain("두바이");
    expect(detectOverseasVenue("2026 new york 단체관 설치", NO_MONGOLIA_KEYWORDS, RULES).reason).toContain("NEW YORK");
  });

  it("단체관이 없으면 해외 지명만으로는 빼지 않는다", () => {
    expect(detectOverseasVenue("두바이 관광객 유치 홍보관 조성", NO_MONGOLIA_KEYWORDS, RULES).isOverseasVenue).toBe(false);
  });

  it("단체관람·단체관광은 단체관이 아니다 — 박람회·해외 지명과 함께여도 빼지 않는다", () => {
    for (const title of ["2026 OO박람회 단체관람 버스 임차 용역", "두바이 단체관광 홍보관 조성", "엑스포 단체관리 시스템"]) {
      expect(detectOverseasVenue(title, NO_MONGOLIA_KEYWORDS, RULES).isOverseasVenue).toBe(false);
    }
  });

  it("영문 지명은 단어로 떨어져 있을 때만 맞춘다 (ASIAN에 ASIA가 걸리지 않게)", () => {
    expect(detectOverseasVenue("ASIAN 단체관 체험", NO_MONGOLIA_KEYWORDS, RULES).isOverseasVenue).toBe(false);
  });
});

describe("detectOverseasVenue — 영문 국가 약자 (2026-10-16)", () => {
  it("'KOREA360 USA'처럼 국가 약자가 있으면 한국관이 없어도 뺀다", () => {
    const result = detectOverseasVenue("2027 관계부처 해외홍보관 미국(KOREA360 USA) 총괄 운영 위탁용역", NO_MONGOLIA_KEYWORDS, RULES);
    expect(result.shouldAutoExclude).toBe(true);
    expect(result.reason).toContain("USA");
  });

  it("약자는 대문자 단어로만 맞춘다 — 다른 영문 단어 속이나 소문자는 걸리지 않는다", () => {
    for (const title of ["UKULELE 체험 전시", "USAGE 분석 전시", "focus on us 전시", "BUSAN 전시관 조성"]) {
      expect(detectOverseasVenue(title, NO_MONGOLIA_KEYWORDS, RULES).isOverseasVenue).toBe(false);
    }
  });

  it("숫자·괄호·한글이 붙어도 약자로 본다", () => {
    expect(detectOverseasVenue("아랍에미리트(UAE) 홍보관", NO_MONGOLIA_KEYWORDS, RULES).isOverseasVenue).toBe(true);
    expect(detectOverseasVenue("USA2026 전시", NO_MONGOLIA_KEYWORDS, RULES).isOverseasVenue).toBe(true);
  });

  it("실제 설정 파일에 우리 공고 제목에 흔한 약자(AI·LED·XR·CCTV)가 들어 있지 않다", () => {
    const rules = loadOverseasRules();
    for (const t of ["AI 체험관 조성", "LED 미디어월 제작설치", "XR 체험장비 및 콘텐츠 구축", "CCTV 설치", "AR 콘텐츠 제작", "IT 체험관"]) {
      expect(detectOverseasVenue(t, NO_MONGOLIA_KEYWORDS, rules).isOverseasVenue).toBe(false);
    }
  });

  it("실제 설정 파일에 국내 공고와 겹치는 약자·몽골 약자가 없다 (설정 파일 주석의 제외 목록)", () => {
    const abbreviations = new Set(loadOverseasRules().countryAbbreviations);
    const clash = ["MNG", "MN", "KOR", "PRK", "JP", "IT", "ES", "CH", "AT", "ID", "IN", "CA", "CAN", "TR", "GB", "PL", "HK", "AR", "AI",
      "BHS", "HRV", "GRC", "GTM", "NER", "SSD", "UKR", "AND", "ARM", "COD", "DMA", "ESP", "IND", "MAC", "NOR", "LCA", "STP", "TLS", "SMR",
      "ECU", "LUX", "CRI", "TUV", "PNG", "DJI", "BTN", "MRT", "IOT", "HMD"];
    expect(clash.filter((c) => abbreviations.has(c))).toEqual([]);
    expect(abbreviations.has("USA")).toBe(true);
    expect(abbreviations.has("UAE")).toBe(true);
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
