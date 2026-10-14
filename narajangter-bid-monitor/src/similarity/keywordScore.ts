import { FACILITY_TERMS } from "./workTerms.js";

/**
 * 실적 키워드 점수 — 공고와 과거 실적에 함께 나온 실적 키워드(workTerms.ts)로 매기는 유사도.
 *
 * 왜 넣었나 (2026-10-13 사용자 지적): 화면의 근거 키워드는 "박물관" 하나만 겹치는데 싱크로율은 그럴듯하게
 * 나오는 경우가 있었다 — 점수(글자 조각 비교)와 근거가 따로 놀았다. 점수의 80%를 이 키워드로 매기면 화면에
 * 보이는 근거가 곧 점수의 근거가 된다.
 *
 * 실측 (지일 과거 실적 151건을 자기 제외하고 서로 비교 vs 키워드 목록을 만들 때 쓰지 않은 비대상 문서).
 * 두 집단이 갈리는 정도(AUC, 1이면 완벽):
 *                                     본문 기준                       제목만
 *                                     새 무관 60건 · 헷갈리는 비대상 53건
 *   글자 조각만 (예전)                0.81 · 0.57                     0.75 · 0.47   ← 헷갈리는 공고를 거의 못 갈랐다
 *   키워드 50% (작은 묶음 할인 없이)  0.91 · 0.81                     0.89 · 0.71
 *   키워드 50% + 할인 2               0.98 · 0.96                     0.87 · 0.71
 *   키워드 80% + 할인 2              0.98 · 0.98                     0.89 · 0.76
 *   위 + 방식어(제작설치 등) 무게 낮춤 ← 채택  0.99 · 0.98            0.89 · 0.69   ← 제목만은 조금 내려가도 말 하나로 부풀지 않게
 *   키워드만 + 할인 2                 0.98 · 0.98                     0.88 · 0.78
 * 비중은 SimilarityIndex의 DEFAULT_KEYWORD_WEIGHT.
 *
 * 시설 이름(박물관·과학관·전시관…)과 일하는 방식(제작설치·실시설계…)은 무게를 0.4로 낮춘다(workTerms.ts의 FACILITY_TERMS) —
 * 시설 이름은 지일 일이 아닌 시설 유지보수 공사에도 그대로 나오고, 방식어는 무엇을 만드는지 말하지 않아
 * 그것만 겹쳐서는 같은 일이라고 볼 수 없다.
 */

export const FACILITY_WEIGHT = 0.4;

const termWeight = (term: string) => (FACILITY_TERMS.has(term) ? FACILITY_WEIGHT : 1);

/** 띄어쓰기·가운뎃점·'및'을 지운 꼴 — "제작·설치", "제작 및 설치"도 "제작설치"로 찾는다 */
export function flattenForTerms(text: string): string {
  return text.replace(/([가-힣])\s*및\s*([가-힣])/g, "$1$2").replace(/[\s·ㆍ‧∙・․]+/g, "");
}

/**
 * 글에 나오는 실적 키워드와 나온 횟수. 긴 말부터 세고 센 자리는 지운다 — "상징조형물" 안의 "조형물"은
 * "조형물"로 다시 세지 않고, 따로 나온 "조형물"만 센다.
 */
export function extractWorkTerms(text: string, vocabulary: string[]): Map<string, number> {
  let flat = flattenForTerms(text);
  const counts = new Map<string, number>();
  for (const term of [...vocabulary].sort((a, b) => b.length - a.length)) {
    if (!flat.includes(term)) continue;
    const parts = flat.split(term);
    counts.set(term, parts.length - 1);
    flat = parts.join("|");
  }
  return counts;
}

/**
 * 나온 횟수를 무게로 바꾸는 방식.
 *   binary: 나오기만 하면 1   ← 채택
 *   log:    1 + ln(횟수) — 10번이면 3.3배, 100번이면 5.6배
 *   sqrt:   √횟수 — 10번이면 3.2배, 100번이면 10배
 *
 * 실측 (2026-10-14, 키워드 80% · 할인 2, 지일 과거사업 vs 헷갈리는 비대상 52건, 과업지시서 기준 AUC):
 *   읽는 길이   binary   log
 *   12,000자    0.987    0.975
 *   20,000자    0.988    0.977(할인 4)
 *   30,000자    0.980
 *   문서 전체   0.967    0.950(할인 8)
 * 과업지시서 뒤쪽은 대부분 일반조건(하자보수·저작권·안전관리)인데 거기에도 "그래픽", "전시물" 같은 말이 지나가듯
 * 나와, 많이 읽을수록·횟수를 셀수록 지일 일이 아닌 공고에도 같은 잡음이 섞였다. 그래서 KEYWORD_TEXT_LIMIT까지만
 * 읽고 나왔는지만 본다 — 12,000자와 가르는 힘은 같으면서 뒤쪽 세부 과업 목록을 더 본다.
 */
export type FrequencyMode = "binary" | "log" | "sqrt";
export const DEFAULT_FREQUENCY_MODE: FrequencyMode = "binary";

/** 실적 키워드를 셀 앞부분 길이 (위 표). 글자 비교(12,000자)보다 길게 읽어 세부 과업 목록을 더 본다. */
export const KEYWORD_TEXT_LIMIT = 20_000;

const frequencyWeight = (count: number, mode: FrequencyMode) =>
  count <= 0 ? 0 : mode === "binary" ? 1 : mode === "log" ? 1 + Math.log(count) : Math.sqrt(count);

/**
 * 작은 묶음 할인 — 코사인 분모 양쪽에 더하는 값.
 *
 * 그냥 코사인이면 키워드가 하나뿐인 두 묶음({과학관} ↔ {과학관})이 만점 1.0이 된다. 실제로 "국립광주과학관
 * 주차장 태양광" 공고가 사업명뿐인 "국립울산 탄소중립 전문과학관"과 키워드 만점을 받았다(2026-10-13).
 * 분모에 상수를 더하면 겹친 말이 적을 때는 점수가 작게 남고, 여러 말이 겹칠수록 코사인에 가까워진다.
 */
export const KEYWORD_SMOOTHING = 2;

export interface KeywordScoreOptions {
  smoothing?: number;
  frequency?: FrequencyMode;
}

/**
 * 두 키워드 묶음의 가중 코사인(작은 묶음 할인 포함)과, 함께 나온 키워드(점수에 많이 보탠 것부터).
 * 무게 = 말의 무게(시설 이름·방식어 0.4) × 나온 횟수의 무게. 한쪽이 비면 0.
 */
export function keywordCosine(
  query: Map<string, number>,
  project: Map<string, number>,
  options: KeywordScoreOptions = {}
): { score: number; shared: string[] } {
  if (query.size === 0 || project.size === 0) return { score: 0, shared: [] };
  const mode = options.frequency ?? DEFAULT_FREQUENCY_MODE;
  const smoothing = options.smoothing ?? KEYWORD_SMOOTHING;
  const weightOf = (term: string, count: number) => termWeight(term) * frequencyWeight(count, mode);
  let inter = 0;
  let qNorm = 0;
  let pNorm = 0;
  const contributions: [string, number][] = [];
  for (const [t, c] of query) {
    const wq = weightOf(t, c);
    qNorm += wq * wq;
    const pc = project.get(t);
    if (pc) {
      const part = wq * weightOf(t, pc);
      inter += part;
      contributions.push([t, part]);
    }
  }
  for (const [t, c] of project) pNorm += weightOf(t, c) ** 2;
  contributions.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return { score: inter / Math.sqrt((qNorm + smoothing) * (pNorm + smoothing)), shared: contributions.map(([t]) => t) };
}
