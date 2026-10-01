import { describe, expect, it } from "vitest";
import { detectScopeFlags } from "../src/matching/taskScopeFlags.js";

const kinds = (text: string) => [...new Set(detectScopeFlags(text).map((f) => f.kind))];

describe("과업에 섞인 본업 밖 업무 찾기 (2026-10-01 실측 문장)", () => {
  it("유물 운송·보험을 찾는다 (송파책박물관 기획특별전)", () => {
    const flags = detectScopeFlags("5) 전시시설 설치 • 기타 사항 6) 전시유물 운송 및 유물종합보험 가입 • 유물 설치 시 전문 인력 활용");
    expect(flags.map((f) => f.kind)).toEqual(["운송"]);
    expect(flags[0]!.sentence).toContain("전시유물 운송 및 유물종합보험 가입");
  });

  it("대여·운송·홍보를 함께 찾는다 (「K-거상」 과업범위)", () => {
    const text =
      "4. 과업범위  전시 연출을 위한 전시품 대여, 전시구조물 제작‧설치, 유지운영  관람객 모객을 위한 전시 홍보물 제작, 홍보 전략 수립  전시유물 운송 및 유물종합보험 가입";
    expect(kinds(text).sort()).toEqual(["대여", "운송", "홍보·도록"].sort());
  });

  it("도록 제작을 찾되 '조화되도록 제작'에는 걸리지 않는다", () => {
    expect(kinds("5) 전시도록 제작 ㅇ 전시 내용 및 자료를 수록한 전시도록 기획·편집")).toEqual(["홍보·도록"]);
    expect(kinds("기존 진열장과 조화되도록 제작 ( 하여야 함")).toEqual([]);
  });

  it("콘텐츠 이름·참가자격 업종명·별도 발주는 과업으로 보지 않는다", () => {
    expect(kinds("M6 물자 운송 경로 디지털 맵 (Ⅲ-3절)")).toEqual([]);
    expect(kinds("다. 기타자유업(행사대행업)[업종코드: 9901]으로 등록된 업체")).toEqual([]);
    expect(kinds("• 전시유물 운송은 별도 발주하여 발주기관에서 수행함")).toEqual([]);
  });

  it("전시 기간 중 시설 유지보수는 경고하지 않는다 (제작·설치 업체의 통상 책임)", () => {
    expect(kinds("• 전시시설 및 전시구조물 제작․설치, 유지 운영 및 폐막 후 철거 • 운영기간 중 유지보수")).toEqual([]);
  });

  it("행사 운영·인력 섭외를 찾는다 (지방시대 엑스포 전북 전시관)", () => {
    expect(kinds("행사운영 전북특별자치도 전시관 관련 행사 운영 이벤트 기획·진행, 진행요원, 의전요원 등 행사관련 인력섭외 및 관리")).toEqual(["운영"]);
    expect(kinds("• 전시 기간 중 도슨트 인력 2명 배치")).toEqual(["운영"]);
  });

  it("설계 조건·인수인계·콘텐츠 이름은 운영 업무로 보지 않는다 (2026-10-01 오탐)", () => {
    expect(kinds("10) 시운전 및 보증, 시설운전·관리안내서 작성, 운영요원의 교육 등 준공 후 운영관리체계를 수립")).toEqual([]);
    expect(kinds("① 운영요원이 최소화될 수 있도록 제작ㆍ설치하되")).toEqual([]);
    expect(kinds("3) 최소한의 운영 요원으로 체험이 가능하게 구성")).toEqual([]);
    expect(kinds("교육훈련 계획: 관람객, 관리자, 운영요원 등 이용대상자별 매뉴얼 상세 제시")).toEqual([]);
    expect(kinds("• AI 도슨트 키오스크 콘텐츠 제작")).toEqual([]);
    expect(kinds("대강당은 강연, 발표, 행사 운영이 가능한 영상·음향 환경으로 구성")).toEqual([]);
    expect(kinds("1) 시공내역, 자재, 일정, 공정별 인원, 상주인력 등 상세히 기재")).toEqual([]);
  });

  it("박물관 소장품 설명·수장고 설계·포토존 설명은 운송·대여·홍보 업무가 아니다", () => {
    expect(kinds("가. 신규 출토유물 및 대여유물을 중심으로 유물을 정비·재구성하여")).toEqual([]);
    expect(kinds("• 전시물 및 유물의 반입·반출·보관을 위한 수장·격납 공간 조성")).toEqual([]);
    expect(kinds("다양한 관람객 참여를 유도하고 SNS 홍보를 위한 AR 포토존 설치")).toEqual([]);
  });
});

describe("운송이 콘텐츠의 주제일 때", () => {
  it("'전시품 포장ㆍ운송ㆍ등록이 담긴 기록영상'은 운송 업무가 아니다", () => {
    const text = "□ 보이는 수장고 전면 수장대, 디지털 유물 정보와 보존처리, 전시품 포장ㆍ운송ㆍ등록이 담긴 기록영상 등 어린이용 콘텐츠";
    expect(detectScopeFlags(text).filter((f) => f.kind === "운송")).toEqual([]);
  });

  it("실제 운송 과업은 그대로 잡는다", () => {
    const text = "- 전시유물 운송 및 유물종합보험 가입";
    expect(detectScopeFlags(text).some((f) => f.kind === "운송")).toBe(true);
  });
});
