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
