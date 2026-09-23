/**
 * 희소 벡터와 코사인 유사도.
 *
 * 벡터를 미리 L2 정규화해 두면 코사인이 내적 하나로 끝난다. 과거사업 103건 × 신규공고
 * 수백 건이면 계산량은 무시할 수준이라 조밀 행렬이나 외부 수치 라이브러리가 필요 없다.
 */

/** 토큰 → 가중치. L2 정규화된 상태로 다닌다 (normalize()가 보장). */
export type SparseVector = Map<string, number>;

/**
 * 벡터를 L2 노름 1로 맞춘다. 길이가 다른 문서(짧은 공고명 vs 긴 과업지시서)를
 * 같은 잣대로 비교하려면 필수다 — 정규화하지 않으면 긴 문서가 무조건 큰 내적을 갖는다.
 *
 * 노름이 0이면(토큰이 하나도 없으면) 빈 벡터를 돌려준다. 이 경우 유사도는 항상 0이 되는데,
 * 사업명이 비어 있거나 전부 불용어인 비정상 입력이므로 0이 맞는 답이다.
 */
export function normalize(vector: SparseVector): SparseVector {
  let sumOfSquares = 0;
  for (const weight of vector.values()) sumOfSquares += weight * weight;
  if (sumOfSquares === 0) return new Map();

  const norm = Math.sqrt(sumOfSquares);
  const out: SparseVector = new Map();
  for (const [token, weight] of vector) out.set(token, weight / norm);
  return out;
}

/**
 * 정규화된 두 벡터의 코사인 유사도 = 내적. 결과는 항상 0 이상 1 이하
 * (TF-IDF 가중치는 음수가 될 수 없으므로 음의 유사도는 나오지 않는다).
 *
 * 더 짧은 쪽을 순회한다 — 과업지시서 본문 벡터는 토큰이 수천 개인데 공고명 벡터는 수십 개라,
 * 순회 대상을 잘못 고르면 불필요하게 수백 배 느려진다.
 */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  return cosineWithEvidence(a, b).score;
}

/**
 * 코사인 값과 함께 **몇 개의 토큰이 실제로 겹쳤는지**를 돌려준다.
 *
 * 점수만 보면 "드문 토큰 하나가 크게 겹친 것"과 "여러 토큰이 두루 겹친 것"을 구분할 수
 * 없다. 전자는 대개 우연이라 호출부가 최소 증거량을 요구할 수 있어야 한다
 * (index.ts의 MIN_SHARED_NGRAMS 참고).
 */
export function cosineWithEvidence(a: SparseVector, b: SparseVector): { score: number; sharedTokens: number } {
  const [shorter, longer] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  let sharedTokens = 0;
  for (const [token, weight] of shorter) {
    const other = longer.get(token);
    if (other !== undefined) {
      dot += weight * other;
      sharedTokens++;
    }
  }
  // 부동소수점 오차로 1을 아주 살짝 넘는 경우가 있어 잘라준다 (동일 문서 비교 시).
  return { score: dot > 1 ? 1 : dot, sharedTokens };
}

/**
 * 포함도(coverage) — "질의의 내용이 문서 안에 얼마나 들어 있는가". 0~1.
 *
 * **길이가 크게 다른 두 텍스트를 비교할 때는 코사인을 쓰면 안 된다.** 20자짜리 공고 제목과
 * 12,000자짜리 과업지시서를 코사인으로 재면, 제목이 본문에 완벽히 포함돼 있어도 점수가
 * 0.1 언저리에서 천장을 친다(분모에 긴 문서의 노름이 통째로 들어가기 때문). 실제로 초기
 * 구현에서 본문 점수가 전부 0.005~0.11에 깔렸고, 그 결과 **본문이 있는 사업일수록 가중평균이
 * 깎여 순위에서 밀리는** 거꾸로 된 동작이 나왔다 — 자료가 많을수록 불리해지는 셈이다.
 *
 * 포함도는 질의 쪽 가중치만 본다. 질의 벡터가 L2 정규화돼 있으므로 전체 제곱합이 1이고,
 * 그중 문서에 등장한 토큰의 제곱합이 곧 "질의의 몇 %가 이 문서에 담겼는가"가 된다.
 * 문서 길이에 영향을 받지 않아서, 사업명끼리의 코사인과 같은 눈금에 놓고 합칠 수 있다.
 */
export function coverage(query: SparseVector, document: SparseVector): number {
  let covered = 0;
  for (const [token, weight] of query) {
    if (document.has(token)) covered += weight * weight;
  }
  return covered > 1 ? 1 : covered;
}

/**
 * 포화 포함도 — 포함도에 "얼마나 자주 나오는가"를 반영한 것. BM25의 tf 포화 항을 쓴다.
 *
 * 순수 포함도는 등장 **여부**만 보기 때문에, 12,000자 과업지시서에 스쳐 지나가듯 한 번
 * 언급된 단어와 문서 전체를 관통하는 주제어를 똑같이 1로 친다. 실제로 "청사 승강기 교체공사"
 * 질의가 유아안전체험관 과업지시서에서 0.79를 받았는데, 그 문서에 '승강기'가 딱 한 번
 * (체험시설 설명 중에) 나왔기 때문이다. 전시업과 아무 상관 없는 공고가 상위로 올라온다.
 *
 * 포화 함수 `tf / (tf + k · 길이보정)`은 이걸 눌러준다: 1회 등장은 낮은 값, 수십 회 등장은
 * 1에 수렴하되 100회와 200회는 거의 차이가 없다("10배 더 전시스럽지는 않다"는 TF-IDF의
 * 로그 압축과 같은 취지).
 *
 * k가 클수록 "한 번 언급"에 박해진다. 과업지시서는 모두 비슷하게 길어서(본문 상한 12,000자)
 * BM25 기본값 1.2로는 1회 등장이 0.45나 받는다 — 이 코퍼스에서는 더 큰 k가 맞다.
 * b는 문서 길이 보정 강도로 BM25 관례값을 쓴다.
 */
export const DEFAULT_SATURATION_K = 8;
export const DEFAULT_LENGTH_NORM_B = 0.75;

export function saturatedCoverage(
  query: SparseVector,
  documentTermFrequency: ReadonlyMap<string, number>,
  documentLength: number,
  averageDocumentLength: number,
  k: number = DEFAULT_SATURATION_K,
  b: number = DEFAULT_LENGTH_NORM_B
): number {
  if (query.size === 0 || documentLength === 0 || averageDocumentLength === 0) return 0;

  const lengthPenalty = k * (1 - b + (b * documentLength) / averageDocumentLength);

  let score = 0;
  let total = 0;
  for (const [token, weight] of query) {
    const mass = weight * weight;
    total += mass;
    const tf = documentTermFrequency.get(token);
    if (tf === undefined || tf === 0) continue;
    score += mass * (tf / (tf + lengthPenalty));
  }
  return total === 0 ? 0 : score / total;
}

/** 자카드 유사도 — 코드 집합처럼 순서·빈도가 의미 없는 자질에 쓴다. */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [shorter, longer] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of shorter) {
    if (longer.has(value)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}
