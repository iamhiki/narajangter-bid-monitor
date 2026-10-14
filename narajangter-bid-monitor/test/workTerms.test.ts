import { describe, expect, it } from "vitest";
import { groupWorkTerms, OTHER_TERM_GROUP, WORK_TERMS, WORK_TERM_GROUPS } from "../src/similarity/workTerms.js";

describe("groupWorkTerms — 공고의 과업 프로필", () => {
  it("묶음 순서대로 나누고, 묶음에 없는 말(등록 키워드 등)은 맨 뒤 '그 밖의 키워드'로", () => {
    expect(groupWorkTerms(["제작설치", "공간", "전시물", "과학관", "디오라마"])).toEqual([
      { name: "시설·공간", terms: ["과학관"] },
      { name: "만드는 것", terms: ["전시물", "디오라마"] },
      { name: "하는 일", terms: ["제작설치"] },
      { name: OTHER_TERM_GROUP, terms: ["공간"] },
    ]);
  });

  it("빈 목록이면 빈 프로필", () => {
    expect(groupWorkTerms([])).toEqual([]);
  });

  it("한 말이 두 묶음에 들어 있지 않다 — 프로필에서 같은 말이 두 번 보이지 않게", () => {
    expect(new Set(WORK_TERMS).size).toBe(WORK_TERMS.length);
    expect(WORK_TERMS.length).toBe(WORK_TERM_GROUPS.reduce((n, g) => n + g.terms.length, 0));
  });
});
