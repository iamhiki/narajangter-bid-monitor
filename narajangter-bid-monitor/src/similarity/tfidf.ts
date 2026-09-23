import { normalize, type SparseVector } from "./cosine.js";
import { termFrequency, tokenize } from "./tokenize.js";

/**
 * TF-IDF 벡터라이저.
 *
 * IDF는 **과거사업 코퍼스에서만** 학습하고, 신규 공고를 벡터로 만들 때도 그 IDF를 쓴다.
 * 신규 공고까지 넣어 IDF를 다시 계산하면 실행할 때마다(그 주에 어떤 공고가 올라왔느냐에 따라)
 * 과거사업 간 유사도까지 흔들려서, 지난주에 0.81이던 점수가 이번주에 0.76이 되는 일이 생긴다.
 * 판정 시트에 점수를 쌓아 임계값을 정하려면 점수가 재현 가능해야 한다.
 */
export class TfidfVectorizer {
  /** 토큰 → IDF 값 */
  private readonly idf = new Map<string, number>();
  private readonly stopPhrases: string[] | undefined;

  private constructor(idf: Map<string, number>, stopPhrases?: string[]) {
    this.idf = idf;
    this.stopPhrases = stopPhrases;
  }

  /**
   * 코퍼스 문서들로 IDF를 학습한다.
   *
   * 평활화된 형태 `ln((N + 1) / (df + 1)) + 1`을 쓴다. `+1` 덕분에 모든 문서에 나오는
   * 토큰도 IDF가 0이 아니라 1이 되어 완전히 사라지지 않고, 코퍼스가 작을 때(지금 103건)
   * 값이 과격하게 튀는 것도 막아준다.
   */
  static fit(documents: string[], stopPhrases?: string[]): TfidfVectorizer {
    const documentFrequency = new Map<string, number>();
    for (const document of documents) {
      for (const token of new Set(tokenize(document, stopPhrases))) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }

    const total = documents.length;
    const idf = new Map<string, number>();
    for (const [token, df] of documentFrequency) {
      idf.set(token, Math.log((total + 1) / (df + 1)) + 1);
    }
    return new TfidfVectorizer(idf, stopPhrases);
  }

  /**
   * 텍스트 → L2 정규화된 TF-IDF 벡터.
   *
   * 학습 때 못 본 토큰은 버린다. 코퍼스에 없던 토큰은 IDF를 알 수 없고, 임의값을 주면
   * "처음 보는 단어일수록 유사도가 올라가는" 거꾸로 된 동작이 된다.
   *
   * TF는 `1 + ln(count)`로 눌러 쓴다. 과업지시서에서 "전시"가 200번 나온다고 해서
   * 20번 나온 문서보다 10배 더 전시스러운 건 아니기 때문이다.
   */
  transform(text: string): SparseVector {
    const vector: SparseVector = new Map();
    for (const [token, count] of termFrequency(tokenize(text, this.stopPhrases))) {
      const idf = this.idf.get(token);
      if (idf === undefined) continue;
      vector.set(token, (1 + Math.log(count)) * idf);
    }
    return normalize(vector);
  }

  /** 학습된 어휘 크기 (진단용) */
  get vocabularySize(): number {
    return this.idf.size;
  }
}
