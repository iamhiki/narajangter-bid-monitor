/**
 * 한글 자모 분해/조합과 자모 단위 편집거리.
 *
 * OCR 오인식은 거의 전부 **자모 하나** 차이로 나타난다. 실측 예:
 *   무릉 → 무름   (종성 ㅇ → ㅁ)
 *   완산벙커 → 완산멍커 (초성 ㅂ → ㅁ)
 *   창호 → 장호   (초성 ㅊ → ㅈ)
 *   진흥 → 진홍   (중성 ㅡ → ㅗ)
 *   1층 → 1츙     (중성 ㅡ → ㅠ)
 *
 * 글자 단위로 보면 `릉`과 `름`은 그냥 "다른 글자"라 거리가 1이든 100이든 구분이 안 되지만,
 * 자모로 펴면 3개 중 1개만 다르다는 게 드러난다. 그래서 교정 사전과 대조할 때는 반드시
 * 자모 단위로 거리를 재야 오인식(고칠 것)과 실제로 다른 낱말(건드리면 안 되는 것)을
 * 가를 수 있다.
 */

const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const MEDIAL_COUNT = 21;
const FINAL_COUNT = 28;

const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const MEDIALS = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
/** 종성 없음을 빈 문자열로 둔다 — 받침 유무 자체가 1글자 차이로 세어진다. */
const FINALS = ["", ..."ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"];

/** 한 글자를 자모 배열로 편다. 한글 음절이 아니면 그 글자 그대로 1개짜리 배열. */
export function decomposeChar(ch: string): string[] {
  const code = ch.codePointAt(0) ?? 0;
  if (code < SYLLABLE_BASE || code > SYLLABLE_LAST) return [ch];

  const offset = code - SYLLABLE_BASE;
  const initial = Math.floor(offset / (MEDIAL_COUNT * FINAL_COUNT));
  const medial = Math.floor((offset % (MEDIAL_COUNT * FINAL_COUNT)) / FINAL_COUNT);
  const final = offset % FINAL_COUNT;

  const parts = [INITIALS[initial] ?? "", MEDIALS[medial] ?? ""];
  const finalJamo = FINALS[final];
  if (finalJamo) parts.push(finalJamo);
  return parts;
}

/** 문자열 전체를 자모 배열로 편다. */
export function decompose(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) out.push(...decomposeChar(ch));
  return out;
}

/**
 * 자모 단위 레벤슈타인 거리.
 *
 * 두 줄짜리 롤링 배열로 계산한다 — 교정 사전 하나당 문서 전체를 훑으므로
 * 호출 횟수가 많고, 전체 행렬을 잡으면 메모리가 아깝다.
 */
export function jamoDistance(a: string, b: string): number {
  const x = decompose(a);
  const y = decompose(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;

  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  let current = new Array<number>(y.length + 1);

  for (let i = 1; i <= x.length; i++) {
    current[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    [previous, current] = [current, previous];
  }
  return previous[y.length] ?? 0;
}

/** 자모 길이 대비 유사도 (1이면 동일). 길이가 다른 낱말을 같은 잣대로 비교할 때 쓴다. */
export function jamoSimilarity(a: string, b: string): number {
  const length = Math.max(decompose(a).length, decompose(b).length);
  if (length === 0) return 1;
  return 1 - jamoDistance(a, b) / length;
}
