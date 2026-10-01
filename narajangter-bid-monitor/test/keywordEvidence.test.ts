import { describe, expect, it } from "vitest";
import { keywordEvidence } from "../src/similarity/keywordEvidence.js";

// 2026-10-01 화면 근거 시험에서 본 문장 모양. 기관·사업명은 바꿔 적었다 — 공개 저장소
describe("싱크로율 근거 — 과업 본문 핵심 키워드", () => {
  const notice = "다. 주요내용 1) 전시설계 및 전시물 제작 설치 2) 전시 관람환경 조성 … 평가위원회 구성 … 전시 물 유지관리 방안";
  const past = "사업명 ○○센터 전시물 설계 및 제작‧설치 … 평가위원회에서 정한다 … ‘전시물’이라 함은 본 사업을 위해 제작한 것";

  it("두 문서에 함께 나온 핵심 키워드만, 각 문서의 문맥과 함께", () => {
    const ev = keywordEvidence(notice, past, ["전시물", "조형물", "체험관"]);
    expect(ev.map((e) => e.keyword)).toEqual(["전시물"]);
    expect(ev[0]!.noticeCount).toBe(2); // "전시 물"처럼 띄어 쓴 것도 센다
    expect(ev[0]!.noticeContext).toContain("전시 물");
    expect(ev[0]!.pastContext).toContain("전시물");
  });

  it("어휘 목록에 없는 행정 문구(평가위원회)는 근거로 나오지 않는다", () => {
    expect(keywordEvidence(notice, past, ["전시물"]).some((e) => e.keyword.includes("평가"))).toBe(false);
  });

  it("긴 말이 잡히면 그 안의 짧은 말은 뺀다", () => {
    const ev = keywordEvidence("상징조형물 제작 설치, 상징 조형물", "○○ 상징조형물을 설치", ["조형물", "상징조형물"]);
    expect(ev.map((e) => e.keyword)).toEqual(["상징조형물"]);
  });

  it("한쪽 본문이 없으면 빈 목록", () => {
    expect(keywordEvidence(notice, "", ["전시물"])).toEqual([]);
  });
});
