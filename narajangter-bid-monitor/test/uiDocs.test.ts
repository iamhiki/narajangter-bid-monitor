import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HIGH_BAND, LOW_BAND } from "../src/similarity/calibrate.js";
import { MAX_ALLOWED_MISSING_QUALIFICATIONS } from "../src/matching/qualificationFilter.js";

/**
 * 웹 화면은 입찰 담당자(비개발자)가 쓴다. 계산 과정·원점수·설정 파일 이름 같은 개발자용 정보가
 * 다시 새어 나오지 않게 막고, 화면의 싱크로율 구간이 코드와 어긋나지 않게 한다.
 * (계산 방식 설명은 화면이 아니라 src/similarity/ 주석에 둔다)
 */

const html = readFileSync(resolve("scripts/ui.html"), "utf8");

describe("화면 구간 상수", () => {
  it("UI 스크립트의 구간 상수가 calibrate.ts와 같다", () => {
    const match = /const HIGH = ([\d.]+), LOW = ([\d.]+);/.exec(html);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(HIGH_BAND);
    expect(Number(match![2])).toBe(LOW_BAND);
  });
});

describe("담당자 화면에 개발자용 정보가 없다", () => {
  it.each([
    ["설정 파일·키 이름", /ANTHROPIC_API_KEY|\.env에/],
    ["계산 근거 대화상자", /계산 근거/],
    ["규칙 매칭 근거 줄", /규칙 근거:/],
    ["보정 전 원점수", /원점수|rawScore/],
    ["동작 원리 탭", /data-tab="how"/],
  ])("%s", (_label, pattern) => {
    expect(html).not.toMatch(pattern);
  });
});

describe("자격 필터 상수", () => {
  it("부족 허용치는 0이다", () => {
    // 1이면 면허제한 공고의 72%(그룹 1개짜리)에 대해 필터가 무력해진다.
    expect(MAX_ALLOWED_MISSING_QUALIFICATIONS).toBe(0);
  });
});
