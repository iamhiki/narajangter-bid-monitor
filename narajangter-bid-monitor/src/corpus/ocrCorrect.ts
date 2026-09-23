import { jamoDistance } from "./hangul.js";

/**
 * OCR 오인식을 **알고 있는 정답 사전**으로 교정한다.
 *
 * 왜 사전 방식인가 — 실측으로 확인한 것:
 *  - 렌더 해상도를 1000 → 5000px(5배)로 올려도 `무릉`은 계속 `무름`으로 읽힌다.
 *    2000px에서 `1층`이 살아난 뒤로는 더 올려도 개선이 없고 시간만 3배 든다.
 *    즉 해상도는 원인이 아니고, Windows OCR 모델 자체의 자모 혼동이다.
 *  - Windows.Media.Ocr는 낱말별 신뢰도 점수를 주지 않는다. 그래서 "확신 없는 글자만
 *    버리기" 같은 필터를 만들 수 없다.
 *
 * 남은 방법은 "이 문서에 나올 수 있는 말"을 미리 알려주고 거기에 맞추는 것이다. 다행히
 * 이 프로젝트가 다루는 문서는 죄다 자사 서류라, 회사명·주소·대표자·자격증명 이름처럼
 * 정답을 이미 아는 낱말이 오인식의 대부분을 차지한다.
 *
 * **교정하지 않는 것**: 사전에 없는 말은 건드리지 않는다. 특히 숫자(사업자번호, 날짜,
 * 금액)는 교정 대상이 아니다 — `2012`를 `2912`로 읽은 것을 고칠 근거가 사전에는 없고,
 * 잘못 고치면 원본보다 나빠진다. 숫자는 사람이 검수해야 한다.
 */

export interface CorrectionEntry {
  /** 정답 표기 */
  correct: string;
  /**
   * 허용 자모 거리. 없으면 낱말 길이에 따라 자동으로 정한다.
   * 짧은 낱말에 큰 거리를 허용하면 전혀 다른 낱말을 끌어와 망가뜨린다.
   */
  maxDistance?: number;
}

export interface CorrectionResult {
  text: string;
  /** 무엇을 무엇으로 고쳤는지 (검수용 — 교정은 반드시 추적 가능해야 한다) */
  changes: { from: string; to: string; distance: number }[];
}

/**
 * 낱말 길이에 맞는 기본 허용 거리.
 *
 * 자모 3개짜리 낱말에 거리 2를 허용하면 사실상 아무 말이나 걸린다. 길이에 비례해
 * 조이되 최대 2로 막는다 — 실측 오인식은 전부 자모 1개 차이였고, 2를 넘어가면
 * 오인식이 아니라 다른 낱말일 가능성이 더 높다.
 */
export function defaultMaxDistance(correct: string): number {
  const length = correct.length;
  if (length <= 2) return 1;
  if (length <= 5) return 1;
  return 2;
}

/**
 * 사전에 있는 낱말과 비슷한 부분을 찾아 정답으로 바꾼다.
 *
 * 텍스트를 낱말 단위로 쪼개지 않고 **정답 길이만큼의 창(window)을 밀며** 비교한다.
 * OCR 결과는 띄어쓰기가 원문과 다르게 나오는 일이 잦아서("무 릉2로", "무릉 2로"),
 * 공백 기준으로 자르면 사전과 맞춰볼 수가 없다.
 */
export interface CorrectOptions {
  /**
   * 정답과 길이가 ±1 다른 창까지 교정 대상으로 볼지. 기본 false.
   *
   * 실측한 OCR 오류는 **전부 같은 길이의 글자 치환**이었다 — 무름2로/무릉2로,
   * 완산멍커/완산벙커, 금속구소물/금속구조물, 장호공사업/창호공사업, 제안업제/제안업체,
   * 한국디자인진홍원/한국디자인진흥원. OCR은 글자를 잘못 읽지, 글자 수를 바꾸지 않는다.
   *
   * 반대로 길이 변동을 허용했더니 멀쩡한 말이 망가졌다: `직접생산확인증명(실물모형)`의
   * `직접생산확인증명`이 사전의 `직접생산확인증명서`와 거리 2라는 이유로 바뀌어버렸다.
   * 얻는 것(띄어쓰기 정규화)은 유사도 계산에서 어차피 공백을 지우므로 필요가 없고,
   * 잃는 것은 원문 훼손이다. 그래서 기본을 끈 상태로 둔다.
   */
  allowLengthVariation?: boolean;
}

export function correctOcrText(
  text: string,
  dictionary: CorrectionEntry[],
  options: CorrectOptions = {}
): CorrectionResult {
  let result = text;
  const changes: { from: string; to: string; distance: number }[] = [];

  // 긴 낱말부터 고친다. "무릉2로"를 먼저 맞추지 않고 "무릉"부터 손대면
  // 긴 쪽 매칭이 어긋나 같은 자리를 두 번 고치게 된다.
  const entries = [...dictionary].sort((a, b) => b.correct.length - a.correct.length);

  for (const entry of entries) {
    const target = entry.correct;
    const limit = entry.maxDistance ?? defaultMaxDistance(target);
    if (limit <= 0) continue;

    const deltas = options.allowLengthVariation ? [0, -1, 1] : [0];
    const sizes: number[] = [];
    for (const delta of deltas) {
      const size = target.length + delta;
      if (size > 0) sizes.push(size);
    }

    let index = 0;
    while (index < result.length) {
      // 1) 정답이 이미 그대로 있으면 손대지 않고 건너뛴다.
      //
      // 이 검사를 먼저 하지 않으면, 길이 -1짜리 창("직접생산확인증명")이 정답
      // ("직접생산확인증명서")과 거리 1이라는 이유로 먼저 걸려서 그 자리에 정답을 끼워 넣고
      // 뒤에 남은 "서"가 그대로 붙는다 — 실제로 "직접생산확인증명서서"가 나왔다.
      if (result.startsWith(target, index)) {
        index += target.length;
        continue;
      }

      // 2) 창 크기별로 재보고 **가장 가까운 것 하나**만 고친다.
      //    먼저 걸린 것을 쓰면 길이가 어긋난 창이 당첨되어 글자가 남거나 잘린다.
      let best: { size: number; window: string; distance: number } | null = null;
      for (const size of sizes) {
        const window = result.slice(index, index + size);
        if (window.length < size) continue;
        if (!hasCleanEdges(window, target)) continue;
        const distance = jamoDistance(window, target);
        if (distance > limit) continue;
        if (!best || distance < best.distance) best = { size, window, distance };
      }

      if (best && best.distance > 0) {
        result = result.slice(0, index) + target + result.slice(index + best.size);
        changes.push({ from: best.window, to: target, distance: best.distance });
        index += target.length;
        continue;
      }

      index++;
    }
  }

  return { text: result, changes };
}

/** 글자(한글·영숫자)인가. 공백·괄호·문장부호는 false. */
function isContentChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[0-9A-Za-z가-힣]/.test(ch);
}

/**
 * 창의 양 끝이 정답의 양 끝과 같은 성격인지 본다.
 *
 * 창 크기에 ±1 여유를 주면 정답 바로 앞뒤의 공백이나 괄호까지 창에 들어온다. 그 상태로
 * 자모거리만 보면 "공백 1개 차이"도 오인식 1개와 똑같이 1로 계산되어, 멀쩡한 구분자를
 * 먹어치운다. 실제로 이런 손상이 나왔다:
 *   "강원도 정선군"    → "강원도정선군"        (앞 공백을 삼킴)
 *   "(사업자등록증 표기)" → "사업자등록증 표기)"  (여는 괄호를 삼킴)
 *   "직접생산확인증명(실물모형)" → "직접생산확인증명서실물모형)" (괄호를 글자로 오인)
 *
 * 정답이 글자로 시작/끝나면 창도 글자로 시작/끝나야 한다고 요구하면 전부 막힌다.
 * 반대로 낱말 내부의 공백을 지우는 교정("중소기업 확인서" → "중소기업확인서")은 그대로 된다.
 */
export function hasCleanEdges(window: string, target: string): boolean {
  if (window.length === 0) return false;
  const windowStart = isContentChar(window[0]);
  const windowEnd = isContentChar(window[window.length - 1]);
  const targetStart = isContentChar(target[0]);
  const targetEnd = isContentChar(target[target.length - 1]);
  return windowStart === targetStart && windowEnd === targetEnd;
}

/**
 * 자사 서류에 반복해서 나오는 고정 표현들.
 *
 * 여기 있는 값이 틀리면 멀쩡한 텍스트를 틀린 값으로 "교정"하게 되므로, 회사 정보가
 * 바뀌면(실제로 대표자와 대표번호가 2022년과 2025년 서류에서 서로 다르다) 반드시
 * 함께 갱신해야 한다. 그래서 상수로 박지 않고 호출부가 넘길 수 있게 열어 둔다.
 */
export const DEFAULT_OCR_DICTIONARY: CorrectionEntry[] = [
  { correct: "직접생산확인증명서" },
  { correct: "중소기업확인서" },
  { correct: "건설업등록증" },
  { correct: "사업자등록증" },
  { correct: "법인등록번호" },
  { correct: "사업수행능력" },
  { correct: "제안업체" },
  { correct: "실내건축공사업" },
  { correct: "금속구조물" },
  { correct: "창호공사업" },
  { correct: "소프트웨어사업자" },
  { correct: "공공디자인전문회사" },
  { correct: "기업부설연구소" },
  { correct: "신용평가등급확인서" },
  { correct: "최근 3년간 관련사업 실적" },
  { correct: "한국디자인진흥원" },
  { correct: "중소벤처기업부" },
];
