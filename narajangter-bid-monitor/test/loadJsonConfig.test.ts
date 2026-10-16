import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import { _resetAppConfigCacheForTests, loadAppConfig } from "../src/config/loadJsonConfig.js";

function writeConfigDir(files: {
  keywords?: unknown;
  codes?: unknown;
  recipients?: unknown;
  heldQualifications?: unknown;
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "narajangter-test-"));
  writeFileSync(path.join(dir, "keywords.json"), JSON.stringify(files.keywords ?? { keywords: ["도서관"] }));
  writeFileSync(
    path.join(dir, "codes.json"),
    JSON.stringify(
      files.codes ?? {
        industryCodes: [{ code: "2", name: "b" }],
      }
    )
  );
  writeFileSync(
    path.join(dir, "recipients.json"),
    JSON.stringify(files.recipients ?? { recipients: ["a@example.com"] })
  );
  writeFileSync(
    path.join(dir, "held-qualifications.json"),
    JSON.stringify(
      files.heldQualifications ?? {
        heldProducts: [{ code: "1", name: "a" }],
        heldIndustries: [{ code: "2", name: "b" }],
      }
    )
  );
  return dir;
}

describe("loadAppConfig", () => {
  const originalDir = process.env.APP_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.APP_CONFIG_DIR;
    _resetAppConfigCacheForTests();
  });

  afterEach(() => {
    if (originalDir) process.env.APP_CONFIG_DIR = originalDir;
    else delete process.env.APP_CONFIG_DIR;
    _resetAppConfigCacheForTests();
  });

  it("정상 설정 파일을 로드한다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({});
    const config = loadAppConfig();
    expect(config.keywords).toEqual(["도서관"]);
    expect(config.recipients).toEqual(["a@example.com"]);
    expect(config.minBudgetAmount).toBeNull();
  });

  it("떠 있는 프로세스에서 설정 파일을 고치면 다음 호출부터 새 설정을 읽는다 (재시작 불필요)", () => {
    const dir = writeConfigDir({ keywords: { keywords: ["도서관"], excludeKeywords: [] } });
    process.env.APP_CONFIG_DIR = dir;
    expect(loadAppConfig().excludeKeywords).toEqual([]);
    expect(loadAppConfig()).toBe(loadAppConfig()); // 안 바뀌었으면 캐시 그대로

    const file = path.join(dir, "keywords.json");
    writeFileSync(file, JSON.stringify({ keywords: ["도서관"], excludeKeywords: ["건설공사"] }));
    // 같은 밀리초 안에 다시 써서 수정 시각이 안 바뀌는 경우를 피한다
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(loadAppConfig().excludeKeywords).toEqual(["건설공사"]);
  });

  it("minBudgetAmount를 지정하면 그대로 로드한다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({
      keywords: { keywords: ["도서관"], minBudgetAmount: 100_000_000 },
    });
    const config = loadAppConfig();
    expect(config.minBudgetAmount).toBe(100_000_000);
  });

  it("잘못된 이메일 형식이면 ConfigError를 던진다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({ recipients: { recipients: ["not-an-email"] } });
    expect(() => loadAppConfig()).toThrow(ConfigError);
  });

  it("recipients가 비어있으면 ConfigError를 던진다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({ recipients: { recipients: [] } });
    expect(() => loadAppConfig()).toThrow(ConfigError);
  });

  it("중복된 코드가 있으면 ConfigError를 던진다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({
      codes: {
        extraProductCodes: [
          { code: "1", name: "a" },
          { code: "1", name: "dup" },
        ],
        industryCodes: [{ code: "2", name: "b" }],
      },
    });
    expect(() => loadAppConfig()).toThrow(ConfigError);
  });

  it("수집 세부품명은 등록 품목 + 추가 관심 품목이고, 키워드 필요 품목에 표시가 붙는다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({
      codes: {
        // "9"는 어느 목록에도 없는 코드 — 등록증에서 빠진 품목처럼 무시돼야 한다
        keywordRequiredProducts: [{ code: "11", name: "안내판" }, { code: "9", name: "없음" }],
        extraProductCodes: [{ code: "20", name: "조합놀이대" }, { code: "10", name: "조형물" }],
        industryCodes: [{ code: "2", name: "b" }],
      },
      heldQualifications: {
        heldProducts: [{ code: "10", name: "조형물" }, { code: "11", name: "안내판" }],
        heldIndustries: [{ code: "2", name: "b" }],
      },
    });
    expect(loadAppConfig().productCodes).toEqual([
      { code: "10", name: "조형물", held: true },
      { code: "11", name: "안내판", held: true, requiresKeyword: true },
      { code: "20", name: "조합놀이대", held: false },
    ]);
  });

  it("held-qualifications.json에 중복된 코드가 있으면 ConfigError를 던진다", () => {
    process.env.APP_CONFIG_DIR = writeConfigDir({
      heldQualifications: {
        heldProducts: [
          { code: "1", name: "a" },
          { code: "1", name: "dup" },
        ],
        heldIndustries: [{ code: "2", name: "b" }],
      },
    });
    expect(() => loadAppConfig()).toThrow(ConfigError);
  });

  it("JSON 파싱에 실패하면 ConfigError를 던진다", () => {
    const dir = writeConfigDir({});
    writeFileSync(path.join(dir, "keywords.json"), "{ not valid json");
    process.env.APP_CONFIG_DIR = dir;
    expect(() => loadAppConfig()).toThrow(ConfigError);
  });
});
