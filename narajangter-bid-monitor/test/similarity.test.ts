import { describe, expect, it } from "vitest";
import type { PastProject } from "../src/corpus/types.js";
import { cosineSimilarity, coverage, jaccardSimilarity, normalize, saturatedCoverage } from "../src/similarity/cosine.js";
import { TfidfVectorizer } from "../src/similarity/tfidf.js";
import { normalizeForTokens, tokenize } from "../src/similarity/tokenize.js";
import { SimilarityIndex, combine, MISSING_BODY_SHRINKAGE } from "../src/similarity/index.js";

describe("tokenize", () => {
  it("띄어쓰기가 달라도 같은 토큰이 나온다", () => {
    // 공고명 표기 흔들림("전시관조성" / "전시관 조성")이 유사도를 떨어뜨리면 안 된다.
    expect(tokenize("전시관 조성")).toEqual(tokenize("전시관조성"));
  });

  it("상투어를 제거한다", () => {
    // "~ 조성 사업 용역(재공고)" 같은 꼬리표가 서로 다른 사업을 비슷해 보이게 만드는 걸 막는다.
    expect(normalizeForTokens("전시관 조성 용역(재공고)")).toBe("전시관조성");
  });

  it("2-gram과 3-gram을 모두 만든다", () => {
    expect(tokenize("전시관")).toEqual(["전시", "시관", "전시관"]);
  });

  it("빈 문자열은 토큰이 없다", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("용역 공고")).toEqual([]); // 전부 불용어
  });
});

describe("cosineSimilarity", () => {
  it("같은 벡터는 1", () => {
    const v = normalize(new Map([["가", 1], ["나", 2]]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it("겹치는 토큰이 없으면 0", () => {
    const a = normalize(new Map([["가", 1]]));
    const b = normalize(new Map([["나", 1]]));
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("빈 벡터는 0 (0으로 나누지 않는다)", () => {
    const empty = normalize(new Map());
    expect(empty.size).toBe(0);
    expect(cosineSimilarity(empty, normalize(new Map([["가", 1]])))).toBe(0);
  });

  it("인자 순서를 바꿔도 같다", () => {
    const a = normalize(new Map([["가", 1], ["나", 1], ["다", 1]]));
    const b = normalize(new Map([["나", 2]]));
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });
});

describe("coverage / saturatedCoverage", () => {
  const query = normalize(new Map([["전시", 1], ["체험", 1]]));

  it("포함도는 문서 길이에 영향받지 않는다", () => {
    // 짧은 제목 대 긴 과업지시서를 코사인으로 재면 0.1에서 천장을 치기 때문에 도입한 지표다.
    const short = normalize(new Map([["전시", 1], ["체험", 1]]));
    const long = normalize(new Map([["전시", 1], ["체험", 1], ...Array.from({ length: 500 }, (_, i): [string, number] => [`잡${i}`, 1])]));
    expect(coverage(query, short)).toBeCloseTo(1, 10);
    expect(coverage(query, long)).toBeCloseTo(1, 10);
  });

  it("스쳐 지나간 1회 언급은 주제어보다 훨씬 낮게 친다", () => {
    // "청사 승강기 교체공사"가 유아안전체험관 과업지시서에서 0.79를 받던 오탐의 해결책.
    const avgLength = 20_000;
    const once = saturatedCoverage(query, new Map([["전시", 1], ["체험", 1]]), avgLength, avgLength);
    const often = saturatedCoverage(query, new Map([["전시", 80], ["체험", 80]]), avgLength, avgLength);
    expect(once).toBeLessThan(0.2);
    expect(often).toBeGreaterThan(0.8);
  });

  it("문서에 없는 토큰은 0으로 친다", () => {
    expect(saturatedCoverage(query, new Map([["무관", 50]]), 1000, 1000)).toBe(0);
  });

  it("빈 질의·빈 문서는 0 (0으로 나누지 않는다)", () => {
    expect(saturatedCoverage(normalize(new Map()), new Map([["전시", 5]]), 1000, 1000)).toBe(0);
    expect(saturatedCoverage(query, new Map(), 0, 1000)).toBe(0);
    expect(saturatedCoverage(query, new Map([["전시", 5]]), 1000, 0)).toBe(0);
  });
});

describe("jaccardSimilarity", () => {
  it("완전히 같은 집합은 1, 빈 집합은 0", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccardSimilarity(new Set(), new Set(["a"]))).toBe(0);
  });

  it("교집합 1 / 합집합 3 = 1/3", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 10);
  });
});

describe("TfidfVectorizer", () => {
  it("모든 문서에 나오는 토큰이어도 사라지지 않는다", () => {
    // 평활화(+1)를 안 하면 IDF가 0이 되어 코퍼스가 작을 때 벡터가 통째로 비어버린다.
    const v = TfidfVectorizer.fit(["전시관", "전시관"]);
    expect(v.transform("전시관").size).toBeGreaterThan(0);
  });

  it("학습에 없던 토큰은 버린다", () => {
    const v = TfidfVectorizer.fit(["전시관"]);
    expect(v.transform("수영장").size).toBe(0);
  });
});

describe("combine", () => {
  it("본문이 있으면 가중 평균", () => {
    expect(combine(1, 0, 0.65, 0.35)).toBeCloseTo(0.65, 10);
    expect(combine(0.5, 0.5, 0.65, 0.35)).toBeCloseTo(0.5, 10);
  });

  it("본문이 없으면 실측 비율(0.512)로 추정해 채운다", () => {
    // 처음엔 사업명 100%로 재정규화했는데, 그건 "본문 점수가 사업명 점수와 같았을 것"이라는
    // 가정이라 2배 낙관적이었다. 본문 있는 사업들의 실측 중앙값이 0.512다.
    const score = combine(0.8, null, 0.65, 0.35);
    expect(score).toBeCloseTo(0.8 * (0.65 + 0.35 * MISSING_BODY_SHRINKAGE), 10);
    expect(score).toBeLessThan(0.8); // 재정규화하던 시절보다 낮다
    expect(score).toBeGreaterThan(0.8 * 0.65); // 그렇다고 본문을 0으로 치지도 않는다
  });

  it("축소 계수를 1로 주면 예전 재정규화와 같아진다", () => {
    expect(combine(0.8, null, 0.65, 0.35, 1)).toBeCloseTo(0.8, 10);
  });
});

describe("최소 공통 n-gram 요건", () => {
  const corpus = [
    project("a", "세월호선체처리"),
    project("b", "국립전북기상과학체험관 전시체험시설 설계 및 제작설치"),
  ];

  it("n-gram 하나만 겹치면 매칭으로 인정하지 않는다", () => {
    // 실측 오탐: "국립농업박물관 소장 박물관자료 보존처리" ↔ "세월호선체처리"가
    // 공통 n-gram 단 1개(`처리`)로 18.6%를 받았다.
    const index = SimilarityIndex.build(corpus);
    const hit = index.findSimilar("국립농업박물관 소장 박물관자료 보존처리", 5).top.find((m) => m.id === "a");
    expect(hit).toBeUndefined();
  });

  it("최소 요건을 1로 낮추면 예전처럼 걸린다 (회귀 확인용)", () => {
    const index = SimilarityIndex.build(corpus, { minSharedNgrams: 1 });
    const hit = index.findSimilar("국립농업박물관 소장 박물관자료 보존처리", 5).top.find((m) => m.id === "a");
    expect(hit?.sharedNameTokens).toBe(1);
  });

  it("세 글자짜리 말이 온전히 겹치면 통과한다", () => {
    // "전시관" → 전시 / 시관 / 전시관 = 3개. 기준값 3의 근거.
    expect(tokenize("전시관")).toHaveLength(3);
  });
});

describe("0점 항목 제외", () => {
  it("겹치는 게 없으면 top에 아무것도 넣지 않는다", () => {
    // 0점을 그대로 내보내면 정렬이 임의 순서가 되어 아무 사업이나 1위로 찍힌다 —
    // 점수 0.0000인 "권봉수 의원"이 유사 과거사업으로 나오던 버그.
    const index = SimilarityIndex.build([project("a", "권봉수 의원"), project("b", "여수항 포토존")]);
    const result = index.findSimilar("관내 상수도 노후관 교체공사", 3);
    expect(result.top).toHaveLength(0);
    expect(result.maxScore).toBe(0);
  });
});

function project(id: string, name: string, body = ""): PastProject {
  return {
    id,
    year: 2024,
    folderName: id,
    name,
    officialName: null,
    body,
    budgetAmount: null,
    sourceFiles: [],
  };
}

describe("SimilarityIndex", () => {
  const corpus = [
    project("a", "남원 수학체험관 전시물 설계 및 제작설치"),
    project("b", "정선군 복합문화센터 공간디자인 및 전시물 제작설치"),
    project("c", "여수항 포토존 및 미니 조형물 제작설치"),
  ];

  it("표기가 조금 달라도 같은 사업을 1위로 올린다", () => {
    const index = SimilarityIndex.build(corpus);
    const result = index.findSimilar("정선군 복합문화센터 공간 디자인 및 전시물 제작·설치");
    expect(result.top[0]?.id).toBe("b");
    expect(result.maxScore).toBeGreaterThan(0.7);
  });

  it("무관한 공고는 낮은 점수만 받는다", () => {
    const index = SimilarityIndex.build(corpus);
    const result = index.findSimilar("관내 도로 제설제 구매");
    expect(result.maxScore).toBeLessThan(0.15);
  });

  it("코퍼스가 비어 있어도 안전하게 0을 돌려준다", () => {
    // 아직 아카이브를 정리하지 않은 환경에서도 파이프라인이 죽으면 안 된다.
    const index = SimilarityIndex.build([]);
    expect(index.size).toBe(0);
    expect(index.findSimilar("아무 공고")).toEqual({ maxScore: 0, top: [], basis: "제목" });
  });

  it("본문이 있는 사업과 없는 사업을 함께 다룰 수 있다", () => {
    const mixed = [
      project("a", "남원 수학체험관 전시물", "수학 원리를 체험하는 전시물을 설계·제작한다"),
      project("b", "여수항 수학체험관 조형물"),
    ];
    const index = SimilarityIndex.build(mixed);
    const result = index.findSimilar("수학체험관 전시물 제작설치");
    // 본문이 있는 쪽이 근거가 더 많아 앞선다.
    expect(result.top[0]?.id).toBe("a");
    // 본문 없는 사업도 이름이 실제로 겹치면 함께 나오고, bodyScore는 null이다.
    const noBody = result.top.find((m) => m.id === "b");
    expect(noBody?.bodyScore).toBeNull();
    expect(noBody?.sharedNameTokens).toBeGreaterThanOrEqual(3);
  });

  it("요청한 개수만큼만 돌려준다", () => {
    const index = SimilarityIndex.build(corpus);
    expect(index.findSimilar("전시물 제작설치", 2).top).toHaveLength(2);
  });
});
