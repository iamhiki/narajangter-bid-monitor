import { describe, expect, it } from "vitest";
import { describeRedactions, redactPersonal } from "../src/redactPersonal.js";
import { decompose, jamoDistance, jamoSimilarity } from "../src/corpus/hangul.js";
import { correctOcrText, defaultMaxDistance } from "../src/corpus/ocrCorrect.js";

describe("redactPersonal", () => {
  it("실제 제안요청서의 담당자 블록을 가린다", () => {
    // 강릉아레나 제안요청서 1쪽에서 실제로 추출된 문장이다.
    const raw = "담 당 성 명 소 속 전화번호 E-mail 이슬 강릉시청 체육과 033-640-5994 lololii@korea.kr";
    const { text, counts } = redactPersonal(raw);
    expect(text).not.toContain("lololii");
    expect(text).not.toContain("033-640-5994");
    expect(text).toContain("[전화번호]");
    expect(text).toContain("[이메일]@korea.kr"); // 기관 식별용 도메인은 남긴다
    expect(counts["전화번호"]).toBe(1);
  });

  it("참여인력 이력의 성명·생년월일을 가린다", () => {
    const raw = "[서식 14] 참여 인력 이력 사항 성 명 김도형 소 속 지일 직 책 차장 생년월일 19800408 최종학력 안동대학교";
    const { text } = redactPersonal(raw);
    expect(text).toContain("성 명 [성명]");
    expect(text).toContain("생년월일 [생년월일]");
    expect(text).not.toContain("김도형");
    expect(text).not.toContain("19800408");
    // 학력은 개인 식별이 아니라 자격 판단에 쓰이므로 남긴다.
    expect(text).toContain("안동대학교");
  });

  it("사업자등록번호와 법인등록번호를 구분해 가린다", () => {
    const raw = "등록번호 : 206-86-36338 법 인 등 록 번 호 : 110111-4182971";
    const { text } = redactPersonal(raw);
    expect(text).toContain("[사업자등록번호]");
    expect(text).toContain("[법인등록번호]");
    expect(text).not.toContain("36338");
    expect(text).not.toContain("4182971");
  });

  it("OCR이 하이픈을 놓친 사업자등록번호도 가린다", () => {
    // 실측: 스캔본에서 "206-86-36338"이 "206 86 36338"로 읽힌다.
    const { text } = redactPersonal("사업자번호 206 86 36338 64");
    expect(text).toContain("[사업자등록번호]");
    expect(text).not.toContain("36338");
  });

  it("주민등록번호를 가린다", () => {
    const { text } = redactPersonal("주민등록번호 800408-1234567");
    expect(text).toContain("[주민등록번호]");
    expect(text).not.toContain("1234567");
  });

  it("사업 내용은 건드리지 않는다", () => {
    // 마스킹이 과하면 ⑤단계 LLM이 판단할 근거 자체가 사라진다.
    const raw = "국립생물자원관 어린이체험실 전시 설계 및 제작·설치, 총사업비 620,000,000원, 과업기간 2026. 7. 31.까지";
    const { text, counts } = redactPersonal(raw);
    expect(text).toBe(raw);
    expect(describeRedactions(counts)).toBe("가린 개인정보 없음");
  });

  it("사업비·면적 숫자를 전화번호로 오인하지 않는다", () => {
    const raw = "총 620,000,000원 / 143㎡ / 2026-07-31";
    expect(redactPersonal(raw).text).toBe(raw);
  });

  it("명단으로 넘긴 이름은 라벨이 없어도 가린다", () => {
    const raw = "본 과업은 김도형 차장이 총괄하며 한영제 부장이 설계를 맡는다";
    const { text, counts } = redactPersonal(raw, { knownNames: ["김도형", "한영제"] });
    expect(text).toBe("본 과업은 [성명] 차장이 총괄하며 [성명] 부장이 설계를 맡는다");
    expect(counts["성명"]).toBe(2);
  });

  it("keepEmailDomain=false면 도메인도 가린다", () => {
    const { text } = redactPersonal("문의 lololii@korea.kr", { keepEmailDomain: false });
    expect(text).toBe("문의 [이메일]");
  });

  it("describeRedactions는 종류별 건수를 한 줄로 만든다", () => {
    const { counts } = redactPersonal("성 명 김도형 전화 033-640-5994");
    expect(describeRedactions(counts)).toContain("전화번호 1건");
    expect(describeRedactions(counts)).toContain("성명 1건");
  });
});

describe("hangul 자모 분해", () => {
  it("초성·중성·종성으로 편다", () => {
    expect(decompose("릉")).toEqual(["ㄹ", "ㅡ", "ㅇ"]);
    expect(decompose("름")).toEqual(["ㄹ", "ㅡ", "ㅁ"]);
    expect(decompose("가")).toEqual(["ㄱ", "ㅏ"]); // 받침 없음
  });

  it("한글이 아닌 글자는 그대로 둔다", () => {
    expect(decompose("A1!")).toEqual(["A", "1", "!"]);
  });

  it("OCR 오인식은 자모 1개 차이로 나타난다", () => {
    // 글자 단위로는 그냥 '다른 글자'지만 자모로 펴면 1개만 다르다는 게 드러난다.
    expect(jamoDistance("무릉", "무름")).toBe(1);
    expect(jamoDistance("완산벙커", "완산멍커")).toBe(1);
    expect(jamoDistance("창호", "장호")).toBe(1);
    expect(jamoDistance("진흥", "진홍")).toBe(1);
  });

  it("실제로 다른 낱말은 거리가 멀다", () => {
    expect(jamoDistance("전시관", "도서관")).toBeGreaterThan(2);
  });

  it("jamoSimilarity는 0~1", () => {
    expect(jamoSimilarity("무릉", "무릉")).toBe(1);
    expect(jamoSimilarity("무릉", "무름")).toBeCloseTo(1 - 1 / 5, 10);
  });
});

describe("correctOcrText", () => {
  const dict = [{ correct: "직접생산확인증명서" }, { correct: "실내건축공사업" }, { correct: "제안업체" }];

  it("자모 1개 오인식을 정답으로 고친다", () => {
    const { text, changes } = correctOcrText("제안업제 일반현황", dict);
    expect(text).toContain("제안업체");
    expect(changes[0]).toMatchObject({ from: "제안업제", to: "제안업체", distance: 1 });
  });

  it("이미 맞는 글자는 고치지 않는다", () => {
    const { text, changes } = correctOcrText("직접생산확인증명서 발급", dict);
    expect(text).toBe("직접생산확인증명서 발급");
    expect(changes).toHaveLength(0);
  });

  it("사전에 없는 말은 건드리지 않는다", () => {
    const raw = "국립생물자원관 어린이체험실";
    expect(correctOcrText(raw, dict).text).toBe(raw);
  });

  it("숫자 오인식은 교정 대상이 아니다", () => {
    // 2012를 2912로 읽은 것은 사전에 근거가 없어 고칠 수 없다 — 사람이 검수해야 한다.
    const raw = "2912.0917. 실내건축공사업등록";
    const { text } = correctOcrText(raw, dict);
    expect(text).toContain("2912.0917.");
    expect(text).toContain("실내건축공사업");
  });

  it("정답 앞뒤의 공백·괄호를 먹지 않는다", () => {
    // 길이에 여유를 주면 인접 구분자까지 창에 들어와 원문을 훼손했다:
    //   "강원도 정선군" → "강원도정선군", "(사업자등록증" → "사업자등록증"
    const raw = "강원도 정선군 남면 / (사업자등록증 표기)";
    const { text } = correctOcrText(raw, [{ correct: "정선군" }, { correct: "사업자등록증" }]);
    expect(text).toBe(raw);
  });

  it("길이가 다른 낱말을 늘려 쓰지 않는다 (기본값)", () => {
    // "직접생산확인증명(실물모형)"의 앞부분이 "직접생산확인증명서"로 바뀌던 과교정.
    // OCR 오류는 전부 같은 길이의 글자 치환이라 길이 변동은 기본에서 끈다.
    const raw = "직접생산확인증명(실물모형)";
    expect(correctOcrText(raw, [{ correct: "직접생산확인증명서" }]).text).toBe(raw);
  });

  it("allowLengthVariation을 켜면 길이가 다른 것도 본다", () => {
    const { text } = correctOcrText("중소기업 확인서", [{ correct: "중소기업확인서" }], {
      allowLengthVariation: true,
    });
    expect(text).toBe("중소기업확인서");
  });

  it("짧은 낱말에는 허용 거리를 좁게 준다", () => {
    // 자모 3개짜리에 거리 2를 허용하면 아무 말이나 걸린다.
    expect(defaultMaxDistance("가나")).toBe(1);
    expect(defaultMaxDistance("직접생산확인증명서")).toBe(2);
  });

  it("전혀 다른 낱말을 끌어오지 않는다", () => {
    const { text } = correctOcrText("도서관 조성", [{ correct: "전시관" }]);
    expect(text).toBe("도서관 조성");
  });
});
