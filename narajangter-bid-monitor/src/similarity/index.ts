import type { PastProject } from "../corpus/types.js";
import {
  cosineSimilarity,
  cosineWithEvidence,
  saturatedCoverage,
  DEFAULT_SATURATION_K,
  DEFAULT_LENGTH_NORM_B,
  type SparseVector,
} from "./cosine.js";
import { TfidfVectorizer } from "./tfidf.js";
import { normalizeForTokens, termFrequency, tokenize } from "./tokenize.js";

export interface SimilarMatch {
  id: string;
  name: string;
  year: number;
  /** 최종 점수 (0~1) */
  score: number;
  /** 사업명끼리 비교한 점수 */
  nameScore: number;
  /** 공고명이 과업지시서 본문에 얼마나 담겨 있는지(포화 포함도). 본문 없으면 null. */
  bodyScore: number | null;
  /** 사업명끼리 실제로 겹친 n-gram 수 — 점수가 우연인지 판단하는 근거 */
  sharedNameTokens: number;
}

/**
 * 점수를 무엇을 근거로 냈는가.
 *
 * **두 기준의 점수는 서로 직접 비교하면 안 된다.** 제목 20자로 낸 점수와 과업지시서
 * 수천 자로 낸 점수는 질의에 담긴 정보량이 달라 분포가 다르다. 임계값(0.35/0.20)도
 * 기준별로 따로 잡아야 하므로, 시트에 이 값을 같이 남겨 나중에 나눠서 보정한다.
 */
export type SimilarityBasis = "제목" | "제목+과업내용";

export interface QueryOptions {
  /** 공고 첨부에서 읽어온 과업 내용. 있으면 본문 비교의 질의로 쓴다. */
  body?: string;
}

export interface SimilarityResult {
  /** 가장 비슷한 과거사업과의 점수. 코퍼스가 비어 있으면 0. */
  maxScore: number;
  /** 상위 N건 */
  top: SimilarMatch[];
  /** 이 점수가 무엇을 근거로 나왔는지 */
  basis: SimilarityBasis;
}

export interface SimilarityOptions {
  /** 사업명 비교 가중치 (기본 0.65) */
  nameWeight?: number;
  /** 본문 비교 가중치 (기본 0.35) */
  bodyWeight?: number;
  stopPhrases?: string[];
  /** 사업명 매칭으로 인정할 최소 공통 n-gram 수 (기본 MIN_SHARED_NGRAMS) */
  minSharedNgrams?: number;
  /** 본문 없는 사업의 점수 축소 계수 (기본 MISSING_BODY_SHRINKAGE) */
  missingBodyShrinkage?: number;
  /** 본문 포화 계수 k (기본 DEFAULT_SATURATION_K). 클수록 1~2회 언급을 박하게 본다. */
  saturationK?: number;
}

/**
 * 사업명 매칭으로 인정할 최소 공통 n-gram 수.
 *
 * 1개만 겹쳐도 점수가 나오던 것이 오탐의 주범이었다. 실측:
 *   "국립농업박물관 소장 박물관자료 보존처리" ↔ "세월호선체처리"
 *   → 공통 n-gram 단 1개(`처리`)로 사업명 점수 0.186
 *
 * 반면 제대로 된 매칭은 공통 n-gram이 10~15개다("부안청자박물관…"↔과거사업 11개,
 * "주진불빛공원 모험놀이터…" 15개). 1~3개와 10개 이상 사이가 뚜렷하게 갈린다.
 *
 * 3으로 잡은 근거: 2·3-gram을 함께 쓰므로 **3글자짜리 낱말이 온전히 겹치면 최소 3개**가
 * 나온다("전시관" → 전시 / 시관 / 전시관). 즉 이 기준은 "적어도 세 글자짜리 말 하나는
 * 통째로 겹쳐야 한다"는 뜻이고, 두 글자 우연 일치(`처리`, `조성`)를 걸러낸다.
 */
export const MIN_SHARED_NGRAMS = 3;

/**
 * 본문이 없는 과거사업의 점수를 줄이는 계수.
 *
 * 처음에는 본문 없는 사업의 가중치를 사업명 100%로 재정규화했다. 자료가 유실됐다는
 * 이유로 점수가 깎이면 안 된다는 취지였는데, 이는 **"본문 점수가 사업명 점수와 같았을
 * 것"이라고 가정**한 것과 같다. 실측해보니 그 가정이 2배 낙관적이었다 —
 * 본문이 있는 사업들의 `본문점수 / 사업명점수` 중앙값이 **0.512**다(질의 10건, 147쌍).
 *
 * 그래서 재정규화 대신 실측 비율을 쓴다. 본문 없는 사업은 사업명 점수의
 * `0.65 + 0.35 × 0.512 ≈ 0.83`배를 받는다. 자료 유실을 벌하지는 않되,
 * 없는 근거를 있는 것처럼 쳐주지도 않는다.
 */
export const MISSING_BODY_SHRINKAGE = 0.512;

interface IndexedProject {
  project: PastProject;
  nameVector: SparseVector;
  /** 본문의 토큰별 등장 횟수. 포화 포함도 계산에 필요해 정규화 벡터와 별도로 갖고 있다. */
  bodyTermFrequency: Map<string, number> | null;
  /** 본문의 L2 정규화 TF-IDF 벡터. 본문끼리 코사인을 잴 때 쓴다. */
  bodyVector: SparseVector | null;
  bodyLength: number;
}

/**
 * 과거사업 코퍼스에 대해 신규 공고의 유사도를 매기는 인덱스.
 *
 * 사업명과 과업지시서 본문을 **따로** 다룬다. 하나로 합치면 본문(수천 자)이 사업명(수십 자)을
 * 완전히 압도해서 제목이 거의 같은 사업조차 상위로 못 올라온다.
 *
 * 비교 방식도 서로 다르다 — 길이가 비슷한 사업명끼리는 코사인, 짧은 제목 대 긴 본문은
 * 포화 포함도를 쓴다. 이유는 cosine.ts의 saturatedCoverage() 주석 참고.
 */
export class SimilarityIndex {
  private constructor(
    private readonly projects: IndexedProject[],
    private readonly nameVectorizer: TfidfVectorizer,
    private readonly bodyVectorizer: TfidfVectorizer | null,
    private readonly averageBodyLength: number,
    private readonly nameWeight: number,
    private readonly bodyWeight: number,
    private readonly minSharedNgrams: number,
    private readonly missingBodyShrinkage: number,
    private readonly saturationK: number
  ) {}

  static build(projects: PastProject[], options: SimilarityOptions = {}): SimilarityIndex {
    const nameWeight = options.nameWeight ?? 0.65;
    const bodyWeight = options.bodyWeight ?? 0.35;

    const nameVectorizer = TfidfVectorizer.fit(
      projects.map((p) => p.name),
      options.stopPhrases
    );

    const bodies = projects.map((p) => p.body).filter((body) => body.length > 0);
    const bodyVectorizer = bodies.length > 0 ? TfidfVectorizer.fit(bodies, options.stopPhrases) : null;

    const indexed: IndexedProject[] = projects.map((project) => {
      if (project.body.length === 0) {
        return { project, nameVector: nameVectorizer.transform(project.name), bodyTermFrequency: null, bodyVector: null, bodyLength: 0 };
      }
      const tokens = tokenize(project.body, options.stopPhrases);
      return {
        project,
        nameVector: nameVectorizer.transform(project.name),
        bodyTermFrequency: termFrequency(tokens),
        bodyVector: bodyVectorizer ? bodyVectorizer.transform(project.body) : null,
        bodyLength: tokens.length,
      };
    });

    const lengths = indexed.map((p) => p.bodyLength).filter((len) => len > 0);
    const averageBodyLength = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;

    return new SimilarityIndex(
      indexed,
      nameVectorizer,
      bodyVectorizer,
      averageBodyLength,
      nameWeight,
      bodyWeight,
      options.minSharedNgrams ?? MIN_SHARED_NGRAMS,
      options.missingBodyShrinkage ?? MISSING_BODY_SHRINKAGE,
      options.saturationK ?? DEFAULT_SATURATION_K
    );
  }

  get size(): number {
    return this.projects.length;
  }

  /**
   * 공고 제목 하나에 대해 가장 비슷한 과거사업을 찾는다.
   *
   * 나라장터 OpenAPI는 공고 제목만 주고 과업내용 첨부파일은 주지 않는다. 그래서 질의 쪽은
   * 항상 제목 한 줄이고, 그 한 줄을 과거사업의 "사업명"과 "본문" 양쪽에 각각 대본다.
   */
  findSimilar(title: string, limit = 3, options: QueryOptions = {}): SimilarityResult {
    if (this.projects.length === 0) return { maxScore: 0, top: [], basis: "제목" };

    const queryForName = this.nameVectorizer.transform(title);
    // 공고 첨부(과업지시서)를 읽어온 경우 본문 비교의 질의를 제목이 아니라 과업 내용 전체로 쓴다.
    // 제목 20자로 12,000자 문서를 재는 것보다 훨씬 많은 근거가 생긴다.
    const bodyQueryText = options.body && options.body.trim().length > 0 ? `${title}\n${options.body}` : title;
    const queryForBody = this.bodyVectorizer ? this.bodyVectorizer.transform(bodyQueryText) : null;
    const hasQueryBody = Boolean(options.body && options.body.trim().length > 0);
    const basis: SimilarityBasis = hasQueryBody ? "제목+과업내용" : "제목";

    const matches: SimilarMatch[] = this.projects.map(
      ({ project, nameVector, bodyTermFrequency, bodyVector, bodyLength }) => {
        const evidence = cosineWithEvidence(queryForName, nameVector);
        // 우연히 겹친 n-gram 한두 개로 점수가 나오면 엉뚱한 사업이 1위가 된다.
        // 증거가 모자라면 사업명 점수를 아예 0으로 본다.
        const nameScore = evidence.sharedTokens >= this.minSharedNgrams ? evidence.score : 0;
        const bodyScore =
          bodyTermFrequency && queryForBody
            ? hasQueryBody
              ? // 양쪽 다 긴 문서(공고 첨부 과업지시서 ↔ 과거 과업지시서)일 때는 코사인이다.
                // 포함도는 "질의의 몇 %가 상대 문서에 있나"라서 질의가 길어질수록 분모가 커져
                // 값이 눌린다 — 실측에서 **자기 자신과 비교해도 0.183**이 나왔고, 본문을 넣으면
                // 점수가 22%→18%로 오히려 떨어졌다. 두 문서의 어휘가 얼마나 겹치는지를 보려면
                // 양쪽을 대등하게 정규화하는 코사인을 써야 한다.
                cosineSimilarity(queryForBody, bodyVector!)
              : // 짧은 제목 ↔ 긴 본문일 때는 반대로 코사인이 0.1에서 천장을 친다.
                // 그때는 포함도(+포화)가 맞다. cosine.ts의 saturatedCoverage 주석 참고.
                saturatedCoverage(queryForBody, bodyTermFrequency, bodyLength, this.averageBodyLength, this.saturationK)
            : null;

        return {
          id: project.id,
          name: project.name,
          year: project.year,
          nameScore,
          bodyScore,
          sharedNameTokens: evidence.sharedTokens,
          score: combine(nameScore, bodyScore, this.nameWeight, this.bodyWeight, this.missingBodyShrinkage),
        };
      }
    );

    matches.sort((a, b) => b.score - a.score);
    // 0점은 "비슷한 게 없다"는 뜻이지 "이게 1위"가 아니다. 그대로 내보내면 정렬이
    // 임의 순서가 되어 아무 사업이나 "유사 과거사업"으로 찍힌다 — 실제로 점수 0인
    // "권봉수 의원"이 1위로 나오던 버그가 여기서 났다.
    const top = matches.filter((m) => m.score > 0).slice(0, limit);
    return { maxScore: top[0]?.score ?? 0, top, basis };
  }

  /**
   * 한 공고와 한 과거사업 사이의 점수가 **어떻게 나왔는지** 항목별로 편다.
   *
   * 0.497 같은 숫자 하나만 보여주면 담당자가 임계값을 정할 근거가 없다. 어떤 n-gram이
   * 얼마를 보탰는지 보여야 "이 점수는 믿을 만하다 / 우연히 겹친 것이다"를 판단할 수 있다.
   * feedbackRow.ts의 "매칭근거" 열이 존재하는 이유와 같다.
   */
  explain(title: string, projectId: string): ScoreExplanation | null {
    const entry = this.projects.find((p) => p.project.id === projectId);
    if (!entry) return null;

    const { project, nameVector, bodyTermFrequency, bodyLength } = entry;
    const queryForName = this.nameVectorizer.transform(title);
    const queryForBody = this.bodyVectorizer ? this.bodyVectorizer.transform(title) : null;

    const nameTerms: ScoreExplanation["nameTerms"] = [];
    const missingFromName: string[] = [];
    for (const [token, queryWeight] of queryForName) {
      const docWeight = nameVector.get(token);
      if (docWeight === undefined) {
        missingFromName.push(token);
        continue;
      }
      nameTerms.push({ token, queryWeight, docWeight, contribution: queryWeight * docWeight });
    }
    nameTerms.sort((a, b) => b.contribution - a.contribution);

    let bodyTerms: ScoreExplanation["bodyTerms"] = null;
    if (bodyTermFrequency && queryForBody && bodyLength > 0 && this.averageBodyLength > 0) {
      const penalty =
        DEFAULT_SATURATION_K *
        (1 - DEFAULT_LENGTH_NORM_B + (DEFAULT_LENGTH_NORM_B * bodyLength) / this.averageBodyLength);
      let totalMass = 0;
      for (const weight of queryForBody.values()) totalMass += weight * weight;

      bodyTerms = [];
      for (const [token, weight] of queryForBody) {
        const tf = bodyTermFrequency.get(token);
        if (tf === undefined || tf === 0) continue;
        const mass = weight * weight;
        const saturation = tf / (tf + penalty);
        bodyTerms.push({
          token,
          mass: totalMass > 0 ? mass / totalMass : 0,
          termFrequency: tf,
          saturation,
          contribution: totalMass > 0 ? (mass / totalMass) * saturation : 0,
        });
      }
      bodyTerms.sort((a, b) => b.contribution - a.contribution);
    }

    const nameScore = cosineSimilarity(queryForName, nameVector);
    const bodyScore =
      bodyTermFrequency && queryForBody
        ? saturatedCoverage(queryForBody, bodyTermFrequency, bodyLength, this.averageBodyLength, this.saturationK)
        : null;

    return {
      query: { raw: title, normalized: normalizeForTokens(title) },
      project: { id: project.id, name: project.name, normalizedName: normalizeForTokens(project.name) },
      nameTerms,
      missingFromName,
      bodyTerms,
      nameScore,
      bodyScore,
      score: combine(nameScore, bodyScore, this.nameWeight, this.bodyWeight),
      weights:
        bodyScore === null
          ? { name: 1, body: 0, applied: "본문 없음 — 사업명 100%로 재정규화" }
          : { name: this.nameWeight, body: this.bodyWeight, applied: `사업명 ${this.nameWeight} · 본문 ${this.bodyWeight}` },
    };
  }
}

/** 점수가 어떻게 나왔는지 항목별로 편 것. 화면·검수용. */
export interface ScoreExplanation {
  query: { raw: string; normalized: string };
  project: { id: string; name: string; normalizedName: string };
  /** 사업명 코사인에 기여한 공통 n-gram (기여도 큰 순) */
  nameTerms: { token: string; queryWeight: number; docWeight: number; contribution: number }[];
  /** 질의에는 있는데 이 사업명에는 없어서 점수를 못 받은 n-gram */
  missingFromName: string[];
  /** 본문 포화 포함도에 기여한 n-gram (본문 없으면 null) */
  bodyTerms: { token: string; mass: number; termFrequency: number; saturation: number; contribution: number }[] | null;
  nameScore: number;
  bodyScore: number | null;
  score: number;
  weights: { name: number; body: number; applied: string };
}

/**
 * 사업명 점수와 본문 점수를 합친다.
 *
 * 본문이 없는 사업(103건 중 32건)은 가중치를 사업명 쪽으로 몰아 **재정규화**한다.
 * 단순히 bodyScore를 0으로 두고 가중합하면, 자료가 유실됐다는 이유만으로 그 사업의 점수가
 * 최대 0.35만큼 깎여 순위에서 부당하게 밀린다. 자료 유실은 그 사업이 덜 비슷하다는 증거가
 * 아니므로, 있는 정보만으로 판단하고 가중치를 다시 1로 맞추는 게 맞다.
 */
export function combine(
  nameScore: number,
  bodyScore: number | null,
  nameWeight: number,
  bodyWeight: number,
  missingBodyShrinkage: number = MISSING_BODY_SHRINKAGE
): number {
  const total = nameWeight + bodyWeight;
  if (total === 0) return 0;

  // 본문이 없으면 "본문 점수가 사업명 점수의 0.512배였을 것"으로 추정해 채운다.
  // 그 값은 본문이 있는 사업들에서 실제로 측정한 중앙값이다.
  if (bodyScore === null) {
    return (nameScore * nameWeight + nameScore * missingBodyShrinkage * bodyWeight) / total;
  }
  return (nameScore * nameWeight + bodyScore * bodyWeight) / total;
}

export { TfidfVectorizer } from "./tfidf.js";
export { cosineSimilarity, cosineWithEvidence, coverage, saturatedCoverage, jaccardSimilarity, normalize } from "./cosine.js";
export { tokenize, normalizeForTokens, DEFAULT_STOP_PHRASES } from "./tokenize.js";
