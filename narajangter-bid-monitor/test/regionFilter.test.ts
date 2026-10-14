import { describe, expect, it } from "vitest";
import { groupRegionsByNotice } from "../src/api/regionLimitApi.js";
import { isOutsideRegion, regionKey } from "../src/matching/regionFilter.js";

describe("groupRegionsByNotice", () => {
  it("공고번호별로 참가 가능 지역을 모으고, 최신 차수만 쓴다", () => {
    const rows = [
      { bidNtceNo: "A", bidNtceOrd: "000", lmtSno: "1", prtcptPsblRgnNm: "서울특별시" },
      { bidNtceNo: "A", bidNtceOrd: "000", lmtSno: "2", prtcptPsblRgnNm: "경기도" },
      { bidNtceNo: "B", bidNtceOrd: "000", lmtSno: "1", prtcptPsblRgnNm: "경상남도" },
      { bidNtceNo: "B", bidNtceOrd: "001", lmtSno: "1", prtcptPsblRgnNm: "강원특별자치도" },
    ];
    const m = groupRegionsByNotice(rows);
    expect(m.get("A")).toEqual(["서울특별시", "경기도"]);
    expect(m.get("B")).toEqual(["강원특별자치도"]);
  });
});

describe("isOutsideRegion", () => {
  const hq = "강원특별자치도";
  it("다른 시·도만 허용하면 지역 밖", () => {
    expect(isOutsideRegion(["경상남도"], hq)).toBe(true);
    expect(isOutsideRegion(["전남광주통합특별시 목포시", "전남광주통합특별시 여수시"], hq)).toBe(true);
  });
  it("본점 시·도가 하나라도 있으면 남긴다 (시·군까지 좁혀도)", () => {
    expect(isOutsideRegion(["서울특별시", "강원특별자치도"], hq)).toBe(false);
    expect(isOutsideRegion(["강원특별자치도 횡성군"], hq)).toBe(false);
    expect(isOutsideRegion(["강원도"], hq)).toBe(false);
  });
  it("지역 정보가 없거나 본점 소재지를 모르면 거르지 않는다", () => {
    expect(isOutsideRegion([], hq)).toBe(false);
    expect(isOutsideRegion(undefined, hq)).toBe(false);
    expect(isOutsideRegion(["경상남도"], null)).toBe(false);
  });
  it("regionKey는 충청·전라·경상의 남북을 구분한다", () => {
    expect(regionKey("경상남도")).toBe("경남");
    expect(regionKey("경상북도")).toBe("경북");
    expect(regionKey("강원특별자치도")).toBe("강원");
  });
});
