import { describe, expect, it } from "vitest";
import { findMakeEvidence, MAKE_EVIDENCE_MIN } from "../src/matching/coreWork.js";

describe("findMakeEvidence — 제목으로 빠진 공고를 첨부로 다시 볼 때", () => {
  it("본업 대상 뒤에 제작·설치가 붙은 문장을 센다", () => {
    const text = "1. 과업 범위 가. 상설전시관 전시물 제작 및 설치 나. 상징조형물 디자인 및 제작·설치 다. 운영 매뉴얼 작성";
    const r = findMakeEvidence(text);
    expect(r.count).toBeGreaterThanOrEqual(MAKE_EVIDENCE_MIN);
    expect(r.samples.map((x) => x.match)).toEqual(["전시물 제작", "상징조형물 디자인 및 제작"]);
  });

  it("건축 설계 과업은 놀이·전시·콘텐츠라는 말이 나와도 본업으로 보지 않는다 (지심도 산마루문화놀이터)", () => {
    const text =
      "과업의 명칭 지심도 산마루문화놀이터 명소화 사업 과업의 목적 유휴공간을 문화 관광 거점으로 재생하기 위한 기본 및 실시설계 " +
      "용도 문화 및 집회시설(전시장) 차별화된 콘텐츠로 거제를 대표하는 생태·문화관광 거점으로 육성 건축분야 토목분야 조경분야";
    expect(findMakeEvidence(text).count).toBe(0);
  });

  it("그냥 '콘텐츠 제작'(홍보·SNS)은 세지 않는다", () => {
    expect(findMakeEvidence("SNS 홍보 콘텐츠 제작 및 온라인 이벤트 운영, 카드뉴스 콘텐츠 제작").count).toBe(0);
  });
});
