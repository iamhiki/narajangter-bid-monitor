import { describe, expect, it } from "vitest";
import { bandOf, calibrate, calibratedPercent, HIGH_BAND, LOW_BAND } from "../src/similarity/calibrate.js";

describe("calibrate — 단조성 (가장 중요)", () => {
  it("원점수 순서를 절대 바꾸지 않는다", () => {
    // 이 성질이 깨지면 눈금 보정이 아니라 순위 조작이 된다.
    for (const basis of ["제목", "제목+과업내용"] as const) {
      let previous = -1;
      for (let raw = 0; raw <= 1.0001; raw += 0.005) {
        const shown = calibrate(raw, basis);
        expect(shown).toBeGreaterThanOrEqual(previous);
        previous = shown;
      }
    }
  });

  it("두 원점수의 대소가 표시값에서도 유지된다", () => {
    const pairs: [number, number][] = [
      [0.12, 0.39],
      [0.39, 0.65],
      [0.05, 0.19],
      [0.19, 0.26],
    ];
    for (const basis of ["제목", "제목+과업내용"] as const) {
      for (const [lo, hi] of pairs) {
        expect(calibrate(lo, basis)).toBeLessThan(calibrate(hi, basis));
      }
    }
  });

  it("0~1 범위를 벗어나지 않는다", () => {
    for (const basis of ["제목", "제목+과업내용"] as const) {
      for (const raw of [-1, 0, 0.5, 1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
        const shown = calibrate(raw, basis);
        expect(shown).toBeGreaterThanOrEqual(0);
        expect(shown).toBeLessThanOrEqual(1);
      }
    }
  });

  it("0점과 음수는 0", () => {
    expect(calibrate(0, "제목")).toBe(0);
    expect(calibrate(-0.5, "제목")).toBe(0);
    expect(calibrate(Number.NaN, "제목")).toBe(0);
  });
});

describe("calibrate — 실측 기준점이 의도한 값으로 간다", () => {
  it("제목 기준: 무관·분야·동일사업이 각 구간에 놓인다", () => {
    // 실측(2026-09-22): 무관 최고 0.121 · 지일 분야 중앙 0.388 · 동일 사업 중앙 0.647
    expect(calibratedPercent(0.121, "제목")).toBeLessThanOrEqual(12);
    expect(calibratedPercent(0.388, "제목")).toBeGreaterThanOrEqual(50);
    expect(calibratedPercent(0.388, "제목")).toBeLessThanOrEqual(60);
    expect(calibratedPercent(0.647, "제목")).toBeGreaterThanOrEqual(80);
    expect(calibratedPercent(0.801, "제목")).toBeGreaterThanOrEqual(90);
  });

  it("본문 기준 (2026-09-30 실측): 같은 문서 100%, 무관 중앙 12% 이하, 지일 과거사업 중앙 50% 안팎", () => {
    expect(calibratedPercent(1.0, "제목+과업내용")).toBe(100);
    expect(calibratedPercent(0.121, "제목+과업내용")).toBeLessThanOrEqual(12);
    expect(calibratedPercent(0.294, "제목+과업내용")).toBe(50);
  });

  it("본문 기준 경계: 0.40부터 높음, 0.20부터 경계선, 비슷해 보이는 비대상 중앙(0.245)은 경계선", () => {
    expect(bandOf(calibrate(0.4, "제목+과업내용"))).toBe("높음");
    expect(bandOf(calibrate(0.39, "제목+과업내용"))).toBe("경계선");
    expect(bandOf(calibrate(0.2, "제목+과업내용"))).toBe("경계선");
    expect(bandOf(calibrate(0.19, "제목+과업내용"))).toBe("낮음");
    expect(bandOf(calibrate(0.245, "제목+과업내용"))).toBe("경계선");
  });

  it("두 기준이 같은 잣대로 읽힌다", () => {
    // 제목 0.388과 본문 0.294는 둘 다 "지일 분야 공고의 가장 비슷한 과거사업"의 중앙값이라 표시값도 비슷해야 한다.
    const a = calibratedPercent(0.388, "제목");
    const b = calibratedPercent(0.294, "제목+과업내용");
    expect(Math.abs(a - b)).toBeLessThanOrEqual(10);
  });
});

describe("bandOf", () => {
  it("구간 경계", () => {
    expect(bandOf(HIGH_BAND)).toBe("높음");
    expect(bandOf(HIGH_BAND - 0.01)).toBe("경계선");
    expect(bandOf(LOW_BAND)).toBe("경계선");
    expect(bandOf(LOW_BAND - 0.01)).toBe("낮음");
    expect(bandOf(0)).toBe("낮음");
  });
});
