import { describe, expect, it } from "vitest";
import { extractBudgetAmount, extractOfficialName, normalizeWhitespace } from "../src/corpus/extractText.js";
import { xmlToText, stripImageNoise } from "../src/corpus/hwpxText.js";
import { joinTextItems } from "../src/corpus/pdfText.js";
import { cleanFolderName } from "../src/corpus/scanArchive.js";

describe("cleanFolderName", () => {
  it("앞의 연도를 떼고 밑줄을 공백으로 바꾼다", () => {
    // 연도를 남기면 같은 해 사업끼리 숫자 때문에 유사도가 올라간다.
    expect(cleanFolderName("2024_무안군_남악_중앙공원_복합놀이시설(물놀이장)_디자인")).toBe(
      "무안군 남악 중앙공원 복합놀이시설(물놀이장) 디자인"
    );
  });

  it("연도가 없는 폴더명도 그대로 정제한다", () => {
    expect(cleanFolderName("보은건강체험관")).toBe("보은건강체험관");
    expect(cleanFolderName("평창군 반값여행 _ 포스터")).toBe("평창군 반값여행 포스터");
  });
});

describe("extractOfficialName", () => {
  it("콜론 뒤 같은 줄에서 뽑는다", () => {
    const body = "Ⅰ 과업개요\n 가. 사 업 명 : 충주씨 테마파크 캐릭터 변경 및 시설물 제작설치\n 나. 사업위치 : 충주시";
    expect(extractOfficialName(body)).toBe("충주씨 테마파크 캐릭터 변경 및 시설물 제작설치");
  });

  it("값이 다음 줄에 있어도 뽑는다", () => {
    const body = "1. 과 업 명\n   국립생물자원관 어린이체험실 전시 설계 및 제작설치\n2. 과업기간\n";
    expect(extractOfficialName(body)).toBe("국립생물자원관 어린이체험실 전시 설계 및 제작설치");
  });

  it("옆 항목 라벨을 사업명으로 잘못 집지 않는다", () => {
    // 라벨만 있고 값이 비어 있는 문서에서 다음 줄("2. 과업 기간")을 집어버리던 버그.
    const body = "1. 과 업 명\n\n2. 과업 기간\n   계약일로부터 180일\n";
    expect(extractOfficialName(body)).toBeNull();
  });

  it("라벨이 없으면 null", () => {
    expect(extractOfficialName("본 용역은 다음과 같이 수행한다.")).toBeNull();
  });
});

describe("extractBudgetAmount", () => {
  it("'금1,700,000,000원' 형태를 읽는다", () => {
    expect(extractBudgetAmount("라. 총사업비 : 금1,700,000,000원(금일십칠억원) - 부가세 포함")).toBe(1_700_000_000);
  });

  it("라벨과 값이 줄바꿈으로 떨어져 있어도 읽는다", () => {
    expect(extractBudgetAmount("4. 사 업 비 \n   총 620,000,000원(설계비 및 VAT포함)")).toBe(620_000_000);
  });

  it("사업비 라벨이 없으면 null — 문서에서 제일 큰 숫자를 집지 않는다", () => {
    // 면적·연도·전화번호·단가표가 걸리는 걸 막기 위한 설계다.
    expect(extractBudgetAmount("전시면적 1,234,567,890㎡ 규모의 체험관")).toBeNull();
  });

  it("천만원 미만은 사업비로 보지 않는다", () => {
    expect(extractBudgetAmount("사업비 : 1,200,000원")).toBeNull();
  });
});

describe("xmlToText", () => {
  it("문단 태그를 줄바꿈으로 바꾼다", () => {
    // 공백으로 바꾸면 항목이 한 줄로 붙어 사업명 추출 정규식이 깨진다.
    expect(xmlToText("<hp:p><hp:t>과 업 명</hp:t></hp:p><hp:p><hp:t>전시관</hp:t></hp:p>")).toContain("\n");
  });

  it("XML 엔티티를 복원한다", () => {
    expect(xmlToText("<hp:t>설계 &amp; 제작</hp:t>")).toContain("설계 & 제작");
  });

  it("글자 서식이 낱말 중간에서 바뀌어도 낱말을 끊지 않는다 (\"기 술능력\" 방지)", () => {
    const xml = '<hp:p><hp:run charPrIDRef="3"><hp:t>기</hp:t></hp:run><hp:run charPrIDRef="4"><hp:t>술능력 평가</hp:t></hp:run></hp:p>';
    expect(xmlToText(xml).trim()).toBe("기술능력 평가");
  });

  it("탭과 표 칸 경계는 띄운다", () => {
    const xml = "<hp:tc><hp:p><hp:t>사업명</hp:t></hp:p></hp:tc><hp:tc><hp:p><hp:t>전시관</hp:t><hp:tab/><hp:t>조성</hp:t></hp:p></hp:tc>";
    expect(xmlToText(xml).replace(/\s+/g, " ").trim()).toBe("사업명 전시관 조성");
  });
});

describe("PDF 텍스트 조각 잇기", () => {
  // transform = [a, b, c, d, x, y], 글자 크기 10. 오른쪽 끝은 x=200
  const item = (str: string, x: number, y: number, width: number) => ({ str, transform: [10, 0, 0, 10, x, y], width });

  it("같은 줄에서 붙어 있는 조각은 붙이고, 벌어진 조각은 띄운다", () => {
    expect(joinTextItems([item("기", 0, 100, 10), item("술능력", 10, 100, 30), item("평가", 45, 100, 20), item("끝", 180, 100, 20)])).toBe("기술능력 평가 끝");
  });

  it("오른쪽 끝까지 찬 줄에서 한글 낱말이 다음 줄로 넘어가면 붙인다", () => {
    expect(joinTextItems([item("전시 콘", 0, 100, 200), item("텐츠와 체험", 0, 85, 60)])).toBe("전시 콘텐츠와 체험");
  });

  it("다 차지 않은 줄(문단 끝)이나 항목 기호로 시작하는 줄은 줄을 바꾼다", () => {
    expect(joinTextItems([item("높이고자 함", 0, 100, 200), item("다. 창의적이고", 0, 85, 80), item("짧은 줄", 0, 70, 40), item("새 문단", 0, 55, 40)])).toBe(
      "높이고자 함\n다. 창의적이고\n짧은 줄\n새 문단"
    );
  });
});

describe("stripImageNoise", () => {
  it("편집기가 심은 그림 메타데이터를 지운다", () => {
    // 모든 문서에 똑같이 반복되는 문구라 그대로 두면 가짜 유사도가 생긴다.
    const noisy = "그림입니다.\n원본 그림의 이름: logo.png\n원본 그림의 크기: 가로 1958pixel, 세로 677pixel\n국립생물자원관";
    const cleaned = stripImageNoise(noisy);
    expect(cleaned).not.toContain("원본 그림의 이름");
    expect(cleaned).not.toContain("그림입니다");
    expect(cleaned).toContain("국립생물자원관");
  });
});

describe("normalizeWhitespace", () => {
  it("줄바꿈은 살리고 가로 공백만 줄인다", () => {
    expect(normalizeWhitespace("가 업  명\n\n\n\n다음")).toBe("가 업 명\n\n다음");
  });
});
