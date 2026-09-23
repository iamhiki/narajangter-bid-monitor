import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJointBidStatus, fetchJointBidStatuses } from "../src/api/jointBidApi.js";
import type { NormalizedNotice } from "../src/api/types.js";

/**
 * g2b.go.kr 비공식 API는 이 프로젝트가 쓰는 조달청 정식 OpenAPI와 완전히 별개이고,
 * 실측 확인(scripts/surveyJointBidG2B.ts)도 g2b.go.kr이 열려 있는 환경에서만 가능했다.
 * 그래서 여기서는 실제 네트워크를 타지 않고 global.fetch를 모의해서, "정상 응답을
 * 정확히 해석하는지"와 "무엇이 잘못돼도 절대 던지지 않고 null/빈 결과로 돌아오는지"만 검증한다.
 * 표시 전용 부가 정보라 후자가 더 중요하다 — 이 조회 하나 때문에 전체 파이프라인이
 * 죽으면 안 된다.
 */

function makeNotice(overrides: Partial<NormalizedNotice> = {}): NormalizedNotice {
  return {
    noticeNo: "R26BK01695832",
    title: "정선군 복합문화센터 공간디자인 및 전시물 제작 설치",
    institution: "정선군",
    businessType: "용역",
    sourceType: "본공고",
    postedAt: null,
    deadline: "2026-10-01",
    budgetAmount: 350000000,
    detailUrl: null,
    industryText: null,
    productClsfcNo: null,
    productClsfcName: null,
    bidMethod: null,
    raw: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJointBidStatus", () => {
  it("정상 응답의 HTML 엔티티를 해석해서 값을 돌려준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ErrorMsg: "정상적으로 조회되었습니다.",
          dmItemMap: { jintCtrtCmnMthoNm: "&#40;전자&#41;분담이행" },
        }),
      })
    );

    const value = await fetchJointBidStatus(makeNotice(), "");
    expect(value).toBe("(전자)분담이행");
  });

  it("HTTP 오류면 null (던지지 않는다)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const value = await fetchJointBidStatus(makeNotice(), "");
    expect(value).toBeNull();
  });

  it("API가 ErrorMsg를 돌려주면 null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ErrorMsg: "해당 공고를 찾을 수 없습니다." }),
      })
    );
    const value = await fetchJointBidStatus(makeNotice(), "");
    expect(value).toBeNull();
  });

  it("네트워크 자체가 막혀 있어도(fetch가 던져도) null — 절대 예외를 던지지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const value = await fetchJointBidStatus(makeNotice(), "");
    expect(value).toBeNull();
  });

  it("필드 자체가 없는 응답(dmItemMap은 왔지만 jintCtrtCmnMthoNm 없음)도 null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ErrorMsg: "정상적으로 조회되었습니다.", dmItemMap: {} }),
      })
    );
    const value = await fetchJointBidStatus(makeNotice(), "");
    expect(value).toBeNull();
  });
});

describe("fetchJointBidStatuses", () => {
  it("여러 건 중 일부만 실패해도 나머지는 계속 조회해 Map에 담는다", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("g2b.go.kr/pn")) {
          call += 1;
          if (call === 2) return Promise.reject(new Error("boom"));
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ErrorMsg: "정상적으로 조회되었습니다.",
              dmItemMap: { jintCtrtCmnMthoNm: `값${call}` },
            }),
          });
        }
        // 세션 쿠키 확보용 홈페이지 GET
        return Promise.resolve({ headers: new Headers() });
      })
    );

    const notices = [
      makeNotice({ noticeNo: "A" }),
      makeNotice({ noticeNo: "B" }),
      makeNotice({ noticeNo: "C" }),
    ];
    const result = await fetchJointBidStatuses(notices, { intervalMs: 0 });

    expect(result.get("A")).toBe("값1");
    expect(result.has("B")).toBe(false); // 2번째 호출은 실패하도록 만들었다
    expect(result.get("C")).toBe("값3");
    expect(result.size).toBe(2);
  });

  it("빈 목록이면 fetch를 아예 부르지 않고 빈 Map을 돌려준다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchJointBidStatuses([]);
    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
