import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HIGH_BAND, LOW_BAND } from "../src/similarity/calibrate.js";

/**
 * 웹 화면은 입찰 담당자(비개발자)가 쓴다. 계산 과정·원점수·설정 파일 이름 같은 개발자용 정보가
 * 다시 새어 나오지 않게 막고, 화면의 싱크로율 구간이 코드와 어긋나지 않게 한다.
 * (계산 방식 설명은 화면이 아니라 src/similarity/ 주석에 둔다)
 */

const html = readFileSync(resolve("scripts/ui.html"), "utf8");

/**
 * 싱크로율 근거 패널(scoreWhyHtml)은 % 숫자를 눌러야만 열리는 개발·검수용이라 원점수를 보여도 된다
 * (2026-10-01 요청: "개발자는 그걸 확인해야 하니까"). 그 함수만 빼고 검사한다.
 */
const whyStart = html.indexOf("function scoreWhyHtml(");
const whyEnd = html.indexOf("\n}\n", whyStart);
const staffHtml = whyStart >= 0 ? html.slice(0, whyStart) + html.slice(whyEnd) : html;

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
    expect(staffHtml).not.toMatch(pattern);
  });

  it("싱크로율 근거 패널은 기본으로 닫혀 있다 (숫자를 눌러야 열림)", () => {
    expect(whyStart).toBeGreaterThan(0);
    expect(html).toMatch(/\.score-why \{\s*display: none;/);
    expect(html).toMatch(/\.card-score\.open \.score-why \{ display: block; \}/);
  });
});

describe("자격 미보유 표기", () => {
  it("나라장터 업종제한 미보유 배지가 공동수급 허용 여부를 함께 보여준다", () => {
    // 미보유 공고는 빼지 않고 표시만 한다 — 공동수급이 되면 참가할 수 있어서
    expect(html).toMatch(/q\.status === "미충족"/);
    expect(html).toMatch(/공동수급 불허/);
  });
});
