import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HIGH_BAND, LOW_BAND } from "../src/similarity/calibrate.js";
import { MAX_ALLOWED_MISSING_QUALIFICATIONS } from "../src/matching/qualificationFilter.js";
import { MIN_SHARED_NGRAMS } from "../src/similarity/index.js";
import { DEFAULT_SATURATION_K } from "../src/similarity/cosine.js";

/**
 * "동작 원리" 탭이 코드와 어긋나는 것을 막는다.
 *
 * 실제로 ③.5 첨부 읽기를 구현하고도 한계 목록에 "질의가 제목 한 줄뿐입니다"가 그대로
 * 남아 있었다. 화면 설명은 담당자가 시스템을 신뢰하는 근거라, 코드보다 뒤처지면
 * 설명이 아니라 오해를 만든다. 상수가 바뀌면 여기서 먼저 깨지게 한다.
 */

const html = readFileSync(resolve("scripts/ui.html"), "utf8");

describe("동작 원리 탭이 코드와 일치한다", () => {
  it("구간 경계를 코드와 같은 값으로 적는다", () => {
    const high = Math.round(HIGH_BAND * 100);
    const low = Math.round(LOW_BAND * 100);
    expect(html).toContain(`높음 ${high}% 이상`);
    expect(html).toContain(`경계선 ${low}~${high}%`);
    // 보정 이전의 원점수 임계값이 화면에 남아 있으면 안 된다.
    expect(html).not.toContain("0.20–0.35");
    expect(html).not.toContain("기준선(0.35 / 0.20)");
  });

  it("UI 스크립트의 구간 상수가 calibrate.ts와 같다", () => {
    const match = /const HIGH = ([\d.]+), LOW = ([\d.]+);/.exec(html);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(HIGH_BAND);
    expect(Number(match![2])).toBe(LOW_BAND);
  });

  it("포화 계수 k를 코드와 같은 값으로 적는다", () => {
    expect(html).toContain(`k = ${DEFAULT_SATURATION_K}`);
  });

  it("최소 공통 n-gram 기준을 코드와 같은 값으로 적는다", () => {
    expect(MIN_SHARED_NGRAMS).toBe(3);
    expect(html).toMatch(/3글자짜리 낱말/);
  });

  it("첨부 읽기가 구현됐다는 사실이 반영돼 있다", () => {
    // 구현 전 문구가 남아 있으면 실패한다.
    expect(html).not.toContain("질의가 제목 한 줄뿐입니다");
    expect(html).not.toContain("과업내용 첨부파일은\n        주지 않습니다");
    expect(html).toContain("ntceSpecDocUrl");
  });

  it("본문 비교에 코사인을 쓴다는 점이 적혀 있다", () => {
    // 포화 포함도만 설명하던 시절의 문구가 남아 있으면 안 된다.
    expect(html).toContain("본문 ↔ 본문");
    expect(html).toMatch(/자기 자신과\s*\n?\s*비교해도 0\.183/);
  });
});

describe("자격 필터 상수", () => {
  it("부족 허용치는 0이다", () => {
    // 1이면 면허제한 공고의 72%(그룹 1개짜리)에 대해 필터가 무력해진다.
    expect(MAX_ALLOWED_MISSING_QUALIFICATIONS).toBe(0);
  });
});

describe("낙찰방법 필터가 실제로 적용됐다는 사실이 반영돼 있다", () => {
  it("적용 전 문구('표시만, 필터 미적용')가 남아 있으면 안 된다", () => {
    expect(html).not.toContain("낙찰방법 판별 <b class=\"warnx\">표시만, 필터 미적용</b>");
    expect(html).not.toContain("표시만, 필터 미적용");
  });

  it("현재 동작(fail-open, requireNegotiatedContract)이 적혀 있다", () => {
    expect(html).toContain("협상에 의한 계약만 통과");
    expect(html).toContain("fail-open");
    expect(html).toContain("requireNegotiatedContract");
  });
});
