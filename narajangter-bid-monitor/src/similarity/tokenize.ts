/**
 * 한국어 공고명/과업지시서용 토크나이저.
 *
 * 형태소 분석기(mecab-ko 등)를 쓰지 않고 **문자 n-gram**을 쓴다. 이유:
 *  1) 공고명은 띄어쓰기가 제각각이다 — "전시관조성" / "전시관 조성" / "전시관  조성"이
 *     같은 사업을 가리킨다. 공백을 지우고 문자 단위로 자르면 이 문제가 사라진다.
 *  2) 형태소 분석기는 네이티브 빌드나 사전 파일이 필요해 GitHub Actions에서 무겁다.
 *  3) "미디어파사드", "실감콘텐츠"처럼 사전에 없는 업계 신조어가 많은데, 문자 n-gram은
 *     사전이 필요 없다.
 *
 * 대가로 "체험형 콘텐츠" ↔ "인터랙티브 전시물" 같은 동의 표현은 못 잡는다. 그건 임베딩의
 * 몫이고, 이 기준선의 성능을 재본 뒤에 도입하면 된다.
 */

/**
 * 어느 사업에나 들어가는 상투어. n-gram으로 자르기 **전에** 문자열에서 지운다.
 * (자른 뒤에는 "용역"이 "시용"·"용역"·"역_" 같은 조각으로 흩어져 제거가 불가능하다.)
 *
 * 이걸 안 지우면 전혀 다른 두 사업이 "~ 조성 사업 용역(재공고)" 같은 꼬리표만으로
 * 0.3~0.4의 바닥 유사도를 갖게 되어, 진짜 신호가 묻힌다.
 */
export const DEFAULT_STOP_PHRASES: string[] = [
  "주식회사",
  "유한회사",
  "제안요청서",
  "과업지시서",
  "과업내용서",
  "일반경쟁",
  "제한경쟁",
  "협상에의한계약",
  "긴급공고",
  "재공고",
  "변경공고",
  "정정공고",
  "용역",
  "공고",
  "입찰",
  "총액",
  "단가",
  "최종",
  "수정",
  "사업",
];

/** 한글·영문·숫자만 남긴다. 괄호/문장부호/이모지는 잡음이라 버린다. */
function keepMeaningful(text: string): string {
  return text.replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, "");
}

/**
 * 연도 표기를 지운다 — `2026년`, `26년`, `2026.` 등.
 *
 * 연도는 사업이 **무엇인지**를 전혀 알려주지 않는데, 숫자라서 토큰으로는 잘 겹친다.
 * 실측에서 `2026년 국립경주박물관 동문주차장 확장공사`가 `26년지역상권육성사업홍천상인회`와
 * 엮인 것이 이 때문이다. 둘의 공통점은 "26년"뿐이다.
 */
function stripYears(text: string): string {
  return text.replace(/\b(19|20)?\d{2}\s*년도?/g, " ").replace(/\b(19|20)\d{2}\s*[.년]?/g, " ");
}

export function normalizeForTokens(text: string, stopPhrases: string[] = DEFAULT_STOP_PHRASES): string {
  let out = stripYears(text.normalize("NFC").toLowerCase());
  for (const phrase of stopPhrases) {
    out = out.split(phrase.toLowerCase()).join("");
  }
  return keepMeaningful(out);
}

/**
 * 2-gram과 3-gram을 함께 쓴다.
 * 2-gram만 쓰면 "전시"가 "전시회 참가 대행"에도 걸려 과하게 관대해지고,
 * 3-gram만 쓰면 짧은 사업명("루지조형물")에서 자질이 너무 적어진다. 둘을 섞으면
 * 짧은 이름과 긴 본문이 같은 기준으로 비교된다.
 */
export const NGRAM_SIZES = [2, 3] as const;

export function tokenize(text: string, stopPhrases: string[] = DEFAULT_STOP_PHRASES): string[] {
  const normalized = normalizeForTokens(text, stopPhrases);
  const tokens: string[] = [];
  for (const n of NGRAM_SIZES) {
    for (let i = 0; i + n <= normalized.length; i++) {
      tokens.push(normalized.slice(i, i + n));
    }
  }
  return tokens;
}

/** 토큰 → 등장 횟수. TF 계산의 입력. */
export function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}
