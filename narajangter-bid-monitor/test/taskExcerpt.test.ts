import { describe, expect, it } from "vitest";
import { taskExcerpt } from "../src/corpus/taskExcerpt.js";

// 과거 과업지시서 151건에서 실제로 나온 표지·목차 모양을 본떴다 (2026-10-01). 사업명·기관은 바꿔 적었다 — 공개 저장소
const first = (body: string) => taskExcerpt(body).split("\n")[0];

describe("과업 요약 발췌 — 표지·목차를 건너뛰고 과업 개요부터", () => {
  it("쪽 번호가 따로 줄에 있는 목차", () => {
    const body =
      "「○○역 상징 조형물 설치」\n\n제 안 요 청 서\n\n목 차\n\nⅠ. 개요\n\n1\n\n 1. 사업목적 2. 사업내용 3. 사업기간\n\nⅡ. 입찰 및 일정\n\n2\n\n" +
      "Ⅰ\n\n 사업개요\n\n 1. 사업목적\n\n ❍ ○○역 회차지 방치로 미관 저해\n\n ❍ 관광객에게 새로운 볼거리 제공";
    expect(first(body)).toBe("사업개요");
    expect(taskExcerpt(body)).toContain("❍ ○○역 회차지 방치로 미관 저해");
  });

  it("줄 끝에 쪽 번호가 붙은 목차 (\"1. 사업 개요 2\", \"1. 주요사항1\")", () => {
    const body =
      "목 차\n\nⅠ. 사업 개요 및 내용\n\n1. 사업 개요 2\n\n2. 사업 내용 2\n\n3. 과업 내용 5\n\nⅡ. 과업 수행지침\n\n1. 과업 기본원칙 10\n\n" +
      "Ⅰ. 사업 개요 및 내용\n\n가. 사 업 명 : ○○교육원 자율주행 트랙 및 학습 공간 조성\n\n나. 사업 목적 : 학생맞춤형 미래교육체험 프로그램 운영을 통한 인재 양성";
    expect(first(body)).toBe("Ⅰ. 사업 개요 및 내용");
    expect(taskExcerpt(body)).toContain("가. 사 업 명 : ○○교육원 자율주행 트랙 및 학습 공간 조성");
    expect(taskExcerpt(body)).not.toContain("과업 기본원칙 10");
  });

  it("본문 장 번호가 한 줄로 따로 있어도 목차로 보지 않는다 (\"Ⅰ. 사업개요 / 1 / 주요사항\")", () => {
    const body =
      "목 차\n\n I. 사업개요\n\n 1. 주요사항1\n\n 2. 사업목적1\n\n 3. 사업범위1\n\n" +
      "Ⅰ. 사업개요\n\n1\n\n 주요사항\n\n□ 사 업 명 : ○○ 실감형 콘텐츠 체험교실 구축\n\n□ 사업기간 : 계약체결일로부터 22. 12. 13.(화)까지\n\n" +
      "실적증명서\n\n사업개요\n\n계약번호\n\n계약일자";
    expect(taskExcerpt(body)).toContain("□ 사 업 명 : ○○ 실감형 콘텐츠 체험교실 구축");
    expect(first(body)).toBe("Ⅰ. 사업개요");
  });

  it("점 사이에 공백이 있는 점선 목차, 줄바꿈 없이 한 줄로 이어진 본문 (PDF)", () => {
    const body =
      "○○과학관 야외과학놀이터 조성 제안요청서 2017. 02 목 차 Ⅰ. 개요 1 1. 사업목적 · · · · · · · · ·1 2. 사업개요 · · · · · · · · ·1 " +
      "3. 입찰방식 · · · · · · · · ·2 Ⅰ. 개요 1. 사업목적 가. 과학놀이 체험 공간 조성 2. 사업개요 가. 사 업 명 : ○○과학관 야외과학놀이터 조성 " +
      "나. 위 치 : ○○시 ○○구 다. 사업금액 : 1,000백만원 (부가가치세 포함) ".repeat(3);
    const ex = taskExcerpt(body);
    expect(ex).not.toMatch(/· · · ·/);
    expect(ex).toContain("가. 사 업 명 : ○○과학관 야외과학놀이터 조성");
  });

  it("'과업의 개요'·단독 '목 적' 제목도 찾는다", () => {
    expect(first("목 차\n\n Ⅰ. 과업의 개요 3\n\n Ⅱ. 과업 일반내용 4\n\nⅠ\n\n과업의 개요\n\n1. 사 업 명 : ○○교 상징조형물")).toBe("과업의 개요");
    expect(first("목 차\n\n1. 공모명 1\n\n2. 목적 1\n\n제1장 제안공모\n\n2. 목 적\n\n ○○신도시에 테마광장 조성")).toBe("2. 목 적");
  });

  it("문장 속 '사업내용'은 제목이 아니다", () => {
    const body = "가) 협상대상자가 제안한 사업내용은 발주처와 협의하여 조정한다\n\n1. 과업개요\n\n가. 과 업 명 : 어린이 교통교육장 체험시설 제작·설치";
    expect(first(body)).toBe("1. 과업개요");
  });

  it("줄 중간에서 자르지 않는다", () => {
    const body = "1. 과업개요\n" + Array.from({ length: 80 }, (_, i) => `가. ${i}번째 과업 내용 설명 문장입니다`).join("\n");
    const ex = taskExcerpt(body, 300);
    expect(ex.endsWith("\n…")).toBe(true);
    expect(ex.split("\n").slice(-2, -1)[0]).toMatch(/설명 문장입니다$/);
  });
});
