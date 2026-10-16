import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "../errors.js";

/**
 * 해외 개최(무역박람회 국가관·한국관 조성) 공고를 제목으로 가린다. 넷 중 하나라도 맞으면 해외 개최다.
 *
 * 1. "한국관"(통합한국관 포함) — 단독으로 (2026-10-16 요청, 팀원이 쓰던 방식). 국내에 '한국관'을 짓는 공고는 없어서
 *    60일치 해외 한국관 공고 18건이 모두 이것으로 빠지고, 함께 빠지는 국내 공고는 지명 '옥동 한국관~송현동' 교통
 *    개선공사뿐이었다. '전시회·박람회'라는 말 없이 나오는 "CES 2027 통합한국관 조성운영 위탁용역", "NANO TECH 2027
 *    한국관 장치/조성" 같은 공고를 잡으려고 단독으로 본다. "한국관광고", "한국관리공단"처럼 다른 낱말로 이어지는
 *    경우(KOREA_PAVILION_PATTERN의 뒷글자)는 한국관으로 치지 않는다.
 * 2. "전시회/박람회/엑스포"와 "단체관"이 함께 — 순서는 양방향 (2026-09-16부터 쓰던 규칙의 단체관 쪽.
 *    "2026 홍콩 코스모프로프 뷰티 전시회 단체관 전시디자인 및 설치용역").
 * 3. 해외 지명(overseasPlaces)과 "단체관"이 함께 (2026-10-16).
 * 4. 영문 국가 약자(countryAbbreviations — USA·UAE·UK)가 단어로 떨어져 있음 (2026-10-16 요청) — "2027 관계부처
 *    해외홍보관 미국(KOREA360 USA) 총괄 운영 위탁용역"처럼 한국관이 없어도 뺀다.
 *
 * 몽골 관련 키워드가 함께 있으면 빼지 않고 플래그만 단다 (회사가 실제로 확장 중인 시장).
 * 국내 박물관 전시실 이름이 '한국관'인 공고가 나오면 함께 빠진다 — 화면 '목록에 올리기'로 살린다.
 */
// 한국관 뒤에 이 글자가 붙으면 다른 낱말이다 (한국관광·한국관리·한국관세·한국관계·한국관련·한국관측·한국관심 …)
const KOREA_PAVILION_PATTERN = /한국관(?!광|리|세|계|련|측|심|람|찰|절|악|제|통|행|개|저)/;
// 단체관람·단체관광·단체관리는 단체관이 아니다 — "박람회 단체관람 버스 임차"가 빠지지 않게
const GROUP = "단체관(?!람|광|리|계|련|심)";
const EXPO_GROUP_PAVILION_PATTERN = new RegExp(`(전시회|박람회|엑스포).*${GROUP}|${GROUP}.*(전시회|박람회|엑스포)`);
const GROUP_PAVILION_PATTERN = new RegExp(GROUP);

function resolveConfigDir(): string {
  return process.env.APP_CONFIG_DIR
    ? path.resolve(process.env.APP_CONFIG_DIR)
    : path.resolve(process.cwd(), "config");
}

const keywordList = z.array(z.string().trim().min(1));
const overseasKeywordsFileSchema = z.object({
  mongoliaKeywords: keywordList.min(1, "mongoliaKeywords 배열이 비어있습니다"),
  overseasPlaces: keywordList.default([]),
  countryAbbreviations: keywordList.default([]),
});

/** 해외 개최 판정에 쓰는 목록 (config/overseas-venue-keywords.json) */
export interface OverseasRules {
  overseasPlaces: string[];
  countryAbbreviations: string[];
}

interface LoadedFile {
  mongoliaKeywords: string[];
  rules: OverseasRules;
}
let cached: LoadedFile | null = null;
/** 캐시를 만들 때의 파일 경로·수정 시각 — 떠 있는 화면 서버에서 파일을 고쳐도 다음 조회부터 반영되게 (loadJsonConfig.ts와 같은 방식) */
let cachedSignature = "";
/** 공고 수만 건을 판정하는 동안 파일 확인을 건마다 하지 않도록, 확인은 1초에 한 번만 */
let checkedAt = 0;
const RECHECK_MS = 1000;

function loadOverseasKeywordsFile(): LoadedFile {
  if (cached && Date.now() - checkedAt < RECHECK_MS) return cached;
  const filePath = path.join(resolveConfigDir(), "overseas-venue-keywords.json");
  let signature = `${filePath}@missing`;
  try {
    signature = `${filePath}@${statSync(filePath).mtimeMs}`;
  } catch {
    // 아래 readFileSync가 알아듣기 쉬운 오류를 낸다
  }
  checkedAt = Date.now();
  if (cached && signature === cachedSignature) return cached;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigError(`설정 파일을 읽을 수 없습니다: ${filePath}\n${err instanceof Error ? err.message : err}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`설정 파일 JSON 파싱 실패: ${filePath}\n${err instanceof Error ? err.message : err}`);
  }

  const result = overseasKeywordsFileSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`설정 파일 검증 실패: ${filePath}\n${details}`);
  }

  const { mongoliaKeywords, overseasPlaces, countryAbbreviations } = result.data;
  cached = { mongoliaKeywords, rules: { overseasPlaces, countryAbbreviations } };
  cachedSignature = signature;
  return cached;
}

/**
 * 몽골 예외 판별용 국가/도시 키워드를 config/overseas-venue-keywords.json에서 읽어온다.
 * 코드 수정 없이 이 파일만 고쳐서 도시를 추가/삭제할 수 있게 하기 위함(loadJsonConfig.ts와 동일한 방식).
 */
export function loadMongoliaKeywords(): string[] {
  return loadOverseasKeywordsFile().mongoliaKeywords;
}

/** 해외 지명·국가 약자 목록 (같은 설정 파일) */
export function loadOverseasRules(): OverseasRules {
  return loadOverseasKeywordsFile().rules;
}

/** 테스트에서 캐시를 리셋하기 위한 헬퍼 */
export function _resetMongoliaKeywordsCacheForTests(): void {
  cached = null;
  cachedSignature = "";
  checkedAt = 0;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 영문은 앞뒤에 영문자가 붙지 않은 단어로만 맞춘다 — 'ASIA'가 'ASIAN'에, 'UK'가 'UKULELE'에 걸리지 않게 */
const asWord = (word: string, flags: string): RegExp => new RegExp(`(?<![A-Za-z])${escapeRegExp(word)}(?![A-Za-z])`, flags);

type Matcher = { word: string; test: (title: string) => boolean };
/** 목록별로 한 번만 만든다 (같은 설정이면 같은 배열이 들어온다) */
const compiled = new WeakMap<string[], Matcher[]>();
function matchersOf(words: string[], make: (word: string) => Matcher["test"]): Matcher[] {
  let m = compiled.get(words);
  if (!m) {
    m = words.map((word) => ({ word, test: make(word) }));
    compiled.set(words, m);
  }
  return m;
}

/** 제목에 든 해외 지명 — 한글은 글자 포함, 영문은 대소문자 무시 단어 일치 */
function findOverseasPlace(title: string, places: string[]): string | null {
  const make = (p: string) => {
    if (!/[A-Za-z]/.test(p)) return (t: string) => t.includes(p);
    const re = asWord(p, "i");
    return (t: string) => re.test(t);
  };
  return matchersOf(places, make).find((m) => m.test(title))?.word ?? null;
}

/** 제목에 든 국가 약자 — 대문자 그대로 단어 일치 ('us'·'Uk' 같은 일반 영문과 섞이지 않게) */
function findCountryAbbreviation(title: string, abbreviations: string[]): string | null {
  const make = (a: string) => {
    const re = asWord(a, "");
    return (t: string) => re.test(t);
  };
  return matchersOf(abbreviations, make).find((m) => m.test(title))?.word ?? null;
}

export interface OverseasVenueResult {
  /** 해외 개최로 판정되었는지 (위 세 규칙 중 하나) */
  isOverseasVenue: boolean;
  /** 판정 근거 한 줄 (판정 안 됐으면 null) — 화면 '제외된 공고'의 사유 */
  reason: string | null;
  /** 매칭된 경우, 몽골 관련 키워드가 함께 있어 자동배제 예외 대상인지 */
  isMongolia: boolean;
  /** isMongolia가 true일 때 실제로 매칭된 키워드(디버깅/로그용) */
  matchedMongoliaKeyword: string | null;
  /** ③ 1차 필터에서 자동배제(자격미달)해야 하는지 — 매칭 && 몽골 아님 */
  shouldAutoExclude: boolean;
}

function overseasReason(title: string, rules: OverseasRules): string | null {
  if (KOREA_PAVILION_PATTERN.test(title)) return "제목에 '한국관'";
  if (EXPO_GROUP_PAVILION_PATTERN.test(title)) return "전시회·박람회 단체관";
  if (GROUP_PAVILION_PATTERN.test(title)) {
    const place = findOverseasPlace(title, rules.overseasPlaces);
    if (place) return `해외 지명 '${place}' + 단체관`;
  }
  const abbreviation = findCountryAbbreviation(title, rules.countryAbbreviations);
  if (abbreviation) return `영문 국가 약자 '${abbreviation}'`;
  return null;
}

/**
 * 공고 제목 하나를 판별한다. rules를 주지 않으면 config/overseas-venue-keywords.json의 목록을 쓴다.
 *
 * 판정표:
 * - 해외 개최 아님                      → shouldAutoExclude=false (표시 없음)
 * - 해외 개최 & 몽골 아님               → shouldAutoExclude=true  (1차 필터 자동배제)
 * - 해외 개최 & 몽골 관련               → shouldAutoExclude=false (자동배제 안 함, 🌐 플래그로 담당자 확인)
 */
export function detectOverseasVenue(title: string, mongoliaKeywords: string[], rules: OverseasRules = loadOverseasRules()): OverseasVenueResult {
  const reason = overseasReason(title, rules);
  if (!reason) {
    return { isOverseasVenue: false, reason: null, isMongolia: false, matchedMongoliaKeyword: null, shouldAutoExclude: false };
  }

  const matchedMongoliaKeyword = mongoliaKeywords.find((keyword) => title.includes(keyword)) ?? null;
  const isMongolia = matchedMongoliaKeyword !== null;

  return {
    isOverseasVenue: true,
    reason,
    isMongolia,
    matchedMongoliaKeyword,
    shouldAutoExclude: !isMongolia,
  };
}
