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
 * 실측 분포 (2026-09-30, 코퍼스 196건 중 본문 151건. 질의는 실제와 같이 "제목 + 본문 12,000자"):
 *   지일 과거사업 151건 — 자기를 빼고 1위     중앙 0.294 · 75% 0.427 · 90% 0.577
 *   비슷해 보이지만 지일 일이 아닌 공고 49건   중앙 0.245 · 90% 0.381 · 최고 0.473
 *     (최근 30일 키워드는 맞았으나 제외 키워드로 빠진 것: 구입·유지관리·감리·행사 대행 등)
 *   무관 용역 60건 (폐기물·감리·실시설계 등)   중앙 0.121 · 75% 0.199 · 최고 0.382
 *
 * 경계 두 개를 이 분포에서 잡았다 (bandOf의 65%·35%가 이 원점수에 오도록 곡선을 맞춤):
 *   0.40 → 65% (높음)   비슷해 보이는 비대상 공고의 8%, 무관 0%만 넘는다. 지일 과거사업은 28%가 넘는다.
 *   0.20 → 35% (경계선) 지일 과거사업의 85%가 이 위다. 무관 공고는 23%만 올라온다.
 * 0.20~0.40 구간에는 지일 일과 "비슷해 보이는 비대상"이 섞여 있다 — 본문 유사도만으로는 가를 수 없어
 * 경계선으로 두고 사람이 본다. 담당자 참가/불참 기록이 쌓이면 그걸로 다시 잡는다.
 *
 * 이전 곡선(본문 40건 기준)은 0.19를 55%로 올려서, 비대상 공고 중앙(0.245)이 70% 가까이 나왔다.
 */
const BODY_CURVE: AnchorCurve = {
  points: [
    { raw: 0.0, shown: 0.0 },
    { raw: 0.121, shown: 0.12 }, // 무관 공고 중앙 → 12%
    { raw: 0.2, shown: 0.35 }, // 경계선 시작
    { raw: 0.294, shown: 0.5 }, // 지일 과거사업 중앙 → 50%
    { raw: 0.4, shown: 0.65 }, // 높음 시작
    { raw: 0.427, shown: 0.7 }, // 지일 과거사업 75분위
    { raw: 0.577, shown: 0.85 }, // 지일 과거사업 90분위
    { raw: 0.8, shown: 0.95 },
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
 * 표시값 기준 구간. 본문 기준은 BODY_CURVE 주석의 실측 분포(지일 과거사업 vs 비대상 공고)로
 * 원점수 0.40/0.20이 여기 오도록 맞췄다. 제목 기준은 아직 2026-09-22 곡선 그대로다.
 *
 * 실측의 "지일 일"은 과거 수행사업이지 담당자가 참가하기로 한 공고가 아니다 — 참가/불참 기록이
 * 쌓이면 그 기록으로 이 경계를 다시 잡는다.
 */
export const HIGH_BAND = 0.65;
export const LOW_BAND = 0.35;

export type SyncBand = "높음" | "경계선" | "낮음";

export function bandOf(shown: number): SyncBand {
  if (shown >= HIGH_BAND) return "높음";
  if (shown >= LOW_BAND) return "경계선";
  return "낮음";
}
