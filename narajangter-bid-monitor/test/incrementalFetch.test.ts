import { describe, expect, it } from "vitest";
import { canContinue, type Store } from "../src/api/incrementalFetch.js";

const store = (begin: Date, end: Date, fullAt: Date): Store => ({
  begin: begin.toISOString(),
  end: end.toISOString(),
  fullAt: fullAt.toISOString(),
  items: [],
});

describe("canContinue — 받아둔 공고에 이어 받을지, 전체를 새로 받을지", () => {
  const fullAt = new Date(2026, 8, 30, 9, 0);
  const saved = store(new Date(2026, 7, 1), fullAt, fullAt);

  it("같은 날, 받아둔 기간이 이번 기간 앞쪽을 덮으면 이어 받는다", () => {
    expect(canContinue(saved, { begin: new Date(2026, 7, 1), end: new Date(2026, 8, 30, 15, 0) })).toBe(true);
  });

  it("날짜가 바뀌면 하루 한 번은 전체를 새로 받는다 (게시 뒤 조용히 고쳐진 행 따라잡기)", () => {
    expect(canContinue(saved, { begin: new Date(2026, 7, 2), end: new Date(2026, 9, 1, 8, 0) })).toBe(false);
  });

  it("이번 기간이 받아둔 것보다 앞에서 시작하면 전체를 새로 받는다", () => {
    expect(canContinue(saved, { begin: new Date(2026, 6, 20), end: new Date(2026, 8, 30, 15, 0) })).toBe(false);
  });

  it("받아둔 것이 없으면 전체를 받는다", () => {
    expect(canContinue(null, { begin: new Date(2026, 7, 1), end: new Date(2026, 8, 30, 15, 0) })).toBe(false);
  });
});
