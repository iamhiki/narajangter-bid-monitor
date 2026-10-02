import type { NormalizedNotice } from "../api/types.js";
import type { CodeEntry } from "../config/loadJsonConfig.js";

export interface CodeMatchResult {
  matchedProductCodes: CodeEntry[];
  matchedIndustryCodes: CodeEntry[];
}

/**
 * 세부품명번호(물품)는 코드 정확일치, 업종코드(용역/공사)는 API가 코드 자체를 내려주지 않으므로
 * "투찰가능업종명" 원문 텍스트에 업종명이 포함되는지로 판단한다.
 */
export function matchCodes(notice: NormalizedNotice, productCodes: CodeEntry[], industryCodes: CodeEntry[]): CodeMatchResult {
  const matchedProductCodes: CodeEntry[] = [];
  const matchedIndustryCodes: CodeEntry[] = [];

  if (notice.businessType === "물품" && notice.productClsfcNo) {
    for (const entry of productCodes) {
      if (entry.code === notice.productClsfcNo) {
        matchedProductCodes.push(entry);
      }
    }
  }

  if (notice.businessType === "용역" || notice.businessType === "공사") {
    const haystack = notice.industryText ?? "";
    if (haystack) {
      const seenNames = new Set<string>();
      for (const entry of industryCodes) {
        if (haystack.includes(entry.name) && !seenNames.has(entry.name)) {
          matchedIndustryCodes.push(entry);
          seenNames.add(entry.name);
        }
      }
    }
  }

  return { matchedProductCodes, matchedIndustryCodes };
}

/** 키워드 없이 품목만으로도 수집할 수 있는 매칭이 있는지 (requiresKeyword 품목은 제외) */
export function hasStandaloneProductMatch(matchedProductCodes: CodeEntry[]): boolean {
  return matchedProductCodes.some((c) => !c.requiresKeyword);
}

/**
 * 용역 공고의 조달분류(공공조달분류 품명번호, pubPrcrmntClsfcNo)가 등록 분류인가.
 * 제목에 키워드가 없어도 발주기관이 '전시장치설치및디자인서비스'로 분류한 공고는 본업일 가능성이 높다 —
 * 2026-10-01 60일치 시험에서 '고성 마동호 습지센터 전시설계 및 제작·설치'(27억), '호국평화공원 미디어월 및
 * 콘텐츠 제작·설치', '국립인천해양박물관 《기억의 서재》 공간 연출 및 제작·설치'가 이 분류로만 잡혔다.
 * 같은 분류로 박람회 부스·방송 세트·팝업스토어도 올라와서, 제목에 excludeWords가 있으면 분류만으로는 걸지 않는다.
 */
export function matchServiceClasses(notice: NormalizedNotice, serviceClasses: CodeEntry[] = [], excludeWords: string[] = []): CodeEntry[] {
  if (notice.businessType !== "용역" || serviceClasses.length === 0) return [];
  const code = String(notice.raw?.["pubPrcrmntClsfcNo"] ?? "").trim();
  if (!code) return [];
  const hits = serviceClasses.filter((c) => c.code === code);
  if (hits.length === 0) return [];
  const title = notice.title.replace(/\s+/g, "").toLowerCase();
  if (excludeWords.some((w) => title.includes(w.replace(/\s+/g, "").toLowerCase()))) return [];
  return hits;
}
