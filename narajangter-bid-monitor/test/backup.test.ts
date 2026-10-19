import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupContent, restoreIfMissing } from "../src/state/backup.js";

const tempDir = () => mkdtempSync(path.join(tmpdir(), "narajangter-backup-test-"));

describe("backupContent", () => {
  it("최신본과 그날 날짜 사본을 백업 폴더에 쓴다 (한국 날짜 기준)", () => {
    const dir = tempDir();
    // 한국 시각 10/19 08:00 = UTC 10/18 23:00
    backupContent("participation.json", '{"a":1}', dir, new Date("2026-10-18T23:00:00Z"));
    expect(readFileSync(path.join(dir, "participation.json"), "utf8")).toBe('{"a":1}');
    expect(readFileSync(path.join(dir, "날짜별", "participation-2026-10-19.json"), "utf8")).toBe('{"a":1}');
  });

  it("같은 날 다시 저장하면 날짜 사본을 덮어쓴다", () => {
    const dir = tempDir();
    const now = new Date("2026-10-19T03:00:00Z");
    backupContent("participation.json", "1", dir, now);
    backupContent("participation.json", "2", dir, now);
    expect(readdirSync(path.join(dir, "날짜별"))).toEqual(["participation-2026-10-19.json"]);
    expect(readFileSync(path.join(dir, "날짜별", "participation-2026-10-19.json"), "utf8")).toBe("2");
  });

  it("30일보다 오래된 날짜 사본은 지운다", () => {
    const dir = tempDir();
    backupContent("participation.json", "old", dir, new Date("2026-09-01T03:00:00Z"));
    backupContent("participation.json", "mid", dir, new Date("2026-09-25T03:00:00Z"));
    backupContent("participation.json", "new", dir, new Date("2026-10-19T03:00:00Z"));
    expect(readdirSync(path.join(dir, "날짜별")).sort()).toEqual(["participation-2026-09-25.json", "participation-2026-10-19.json"]);
  });

  it("백업 폴더가 없으면(null) 아무것도 하지 않는다", () => {
    expect(() => backupContent("participation.json", "x", null)).not.toThrow();
  });

  it("백업 폴더에 쓸 수 없어도 예외를 던지지 않는다 (저장은 그대로 되어야 한다)", () => {
    const dir = tempDir();
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "");
    // 파일 아래에 폴더를 만들 수 없다
    expect(() => backupContent("participation.json", "x", path.join(blocker, "sub"))).not.toThrow();
  });
});

describe("restoreIfMissing", () => {
  it("이 PC에 파일이 없으면 백업에서 가져온다", () => {
    const local = tempDir();
    const backup = tempDir();
    writeFileSync(path.join(backup, "participation.json"), '{"restored":true}');
    const target = path.join(local, "participation.json");
    expect(restoreIfMissing(target, backup)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe('{"restored":true}');
  });

  it("이 PC에 파일이 있으면 백업으로 덮어쓰지 않는다", () => {
    const local = tempDir();
    const backup = tempDir();
    const target = path.join(local, "participation.json");
    writeFileSync(target, "local");
    writeFileSync(path.join(backup, "participation.json"), "backup");
    expect(restoreIfMissing(target, backup)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("local");
  });

  it("백업도 없으면 아무것도 하지 않는다", () => {
    const target = path.join(tempDir(), "participation.json");
    expect(restoreIfMissing(target, tempDir())).toBe(false);
    expect(restoreIfMissing(target, null)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});
