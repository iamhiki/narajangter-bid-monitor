import type { SimilarityBasis } from "./index.js";

/**
 * 원점수를 사람이 읽는 싱크로율(%)로 바꾼다.
 *
 * **왜 필요한가.** 원점수는 코사인·포함도 값이라 "얼마나 같은가"의 비율이 아니다.
 * 실측하면 사업명이 100% 일치해도 최종 0.80이 천장이고, 같은 업무·다른 현장이 0.50,
 * 무관 공고가 0.12다. 이걸 그대로 "싱크로율 50%"로 보여주면 "절반이 같다"로 읽히는데
 * 실제 뜻은 "같은 종류의 일"이다. 팀장이 기대한 감각(강한 일치 = 90%대)과도 어긋난다.
 *
 * **왜 안전한가.** 이 변환은 **단조 증가**다. 원점수 순서를 하나도 바꾸지 않으므로
 * 순위·판별력이 전혀 달라지지 않는다. 눈금만 바꾼다. 점수를 올리려고 포화계수 k나
 * 가중치를 건드리는 것과는 다르다 — 그건 분리도를 실제로 망가뜨린다(측정으로 확인).
 *
 * **왜 기준별로 다른 곡선인가.** 제목만 본 점수와 과업지시서까지 읽은 점수는 분포가
 * 완전히 다르다(아래 실측표). 한 곡선으로 누르면 한쪽이 반드시 틀어진다. 기준별로
 * 보정하면 **두 기준의 값을 같은 잣대로 읽을 수 있게 되는** 부수 효과도 생긴다.
 */

/** 원점수 → 표시값(0~1) 대응점. x는 오름차순이어야 한다. */
interface AnchorCurve {
  points: { raw: number; shown: number }[];
}

/**
 * 기준 1 — 공고 제목만 보고 낸 점수 (첨부를 못 읽은 경우, 실측 61%).
 *
 * 실측 분포 (코퍼스 103건, 2026-09-22):
 *   동일 사업(정답 9쌍)  중앙 0.647 · 최고 0.801
 *   지일 분야 10건 1위    중앙 0.388 · 최고 0.539
 *   무관 10건 1위        중앙 0.034 · 최고 0.121
 *
 * 이 세 덩어리가 각각 "거의 같은 사업 / 해볼 만한 일 / 무관"으로 읽히도록 맞춘다.
 */
const TITLE_CURVE: AnchorCurve = {
  points: [
    { raw: 0.0, shown: 0.0 },
    { raw: 0.12, shown: 0.1 }, // 무관 최고 → 10%
    { raw: 0.25, shown: 0.3 },
    { raw: 0.39, shown: 0.55 }, // 지일 분야 중앙 → 55%
    { raw: 0.54, shown: 0.72 }, // 지일 분야 최고 → 72%
    { raw: 0.65, shown: 0.85 }, // 동일 사업 중앙 → 85%
    { raw: 0.8, shown: 0.95 }, // 사업명 완전 일치 → 95%
    { raw: 1.0, shown: 1.0 },
  ],
};

/**
 * 기준 2 — 공고 첨부 과업지시서까지 읽고 낸 점수 (실측 39%).
 *
 * 실측 분포 (본문 보유 40건을 서로 대조):
 *   자기 자신            1.000
 *   가장 비슷한 다른 사업  중앙 0.191 · 75% 0.254
 *   30위권(사실상 무관)   중앙 0.048
 *
 * 본문끼리 코사인은 서로 다른 문서면 0.15~0.25에 머문다 — 1만 5천 토큰짜리 문서 둘의
 * 공통 어휘가 2,500개 수준이라 구조적으로 그렇다. 그래서 곡선이 제목 기준보다 가파르다.
 */
const BODY_CURVE: AnchorCurve = {
  points: [
    { raw: 0.0, shown: 0.0 },
    { raw: 0.05, shown: 0.08 }, // 무관 중앙 → 8%
    { raw: 0.1, shown: 0.25 },
    { raw: 0.19, shown: 0.55 }, // 가장 비슷한 다른 사업 중앙 → 55%
    { raw: 0.26, shown: 0.72 }, // 75분위 → 72%
    { raw: 0.4, shown: 0.85 },
    { raw: 0.7, shown: 0.95 },
    { raw: 1.0, shown: 1.0 }, // 같은 문서 → 100%
  ],
};

function interpolate(curve: AnchorCurve, raw: number): number {
  const pts = curve.points;
  if (raw <= pts[0]!.raw) return pts[0]!.shown;
  const last = pts[pts.length - 1]!;
  if (raw >= last.raw) return last.shown;

  for (let i = 1; i < pts.length; i++) {
    const hi = pts[i]!;
    if (raw > hi.raw) continue;
    const lo = pts[i - 1]!;
    const span = hi.raw - lo.raw;
    // 구간 폭이 0이면 나눗셈이 깨진다. 대응점을 잘못 넣었을 때의 방어.
    if (span <= 0) return hi.shown;
    const t = (raw - lo.raw) / span;
    return lo.shown + t * (hi.shown - lo.shown);
  }
  return last.shown;
}

/** 원점수를 표시용 싱크로율(0~1)로 바꾼다. */
export function calibrate(raw: number, basis: SimilarityBasis): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return interpolate(basis === "제목+과업내용" ? BODY_CURVE : TITLE_CURVE, raw);
}

/** 화면·시트에 쓰는 정수 퍼센트. */
export function calibratedPercent(raw: number, basis: SimilarityBasis): number {
  return Math.round(calibrate(raw, basis) * 100);
}

/**
 * 표시값 기준 구간. 원점수 임계값(0.35/0.20)을 보정 눈금으로 옮긴 것이다.
 *
 * 여전히 **가설**이다 — 담당자 O/X 판정이 쌓이면 이 경계부터 데이터로 다시 잡는다.
 */
export const HIGH_BAND = 0.65;
export const LOW_BAND = 0.35;

export type SyncBand = "높음" | "경계선" | "낮음";

export function bandOf(shown: number): SyncBand {
  if (shown >= HIGH_BAND) return "높음";
  if (shown >= LOW_BAND) return "경계선";
  return "낮음";
}
