import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "../errors.js";

/**
 * "전시회/박람회/엑스포"와 "한국관/단체관"이 제목에 함께 등장하면 해외 개최(무역박람회
 * 국가관·한국관 조성) 공고로 판별한다. 순서는 양방향으로 허용한다 — 실제 표기가
 * "OO엑스포 한국관 설치공사"처럼 앞뒤가 바뀌어 나오는 경우가 섞여 있기 때문이다
 * (2026-09-16, 표본 8건 기준 재현율 4/4, 정밀도 4/4 확인).
 *
 * 원래는 "전시회" 단독으로만 잡았으나, 실제 공고 상당수가 "박람회"/"엑스포"라는 단어를
 * 쓰는 것이 확인되어(예: "2026 이스탄불 국제식품박람회 한국관 장치 용역") 셋을 함께 잡도록
 * 확장했다. 제목에 이 한글 키워드가 전혀 없는 경우(예: "HLTH USA")는 구조적으로 잡을 수
 * 없다 — 이 잔여 케이스는 ⑦ 피드백(사람 확인)이 안전망 역할을 한다.
 */
const OVERSEAS_VENUE_PATTERN = /(전시회|박람회|엑스포).*(한국관|단체관)|(한국관|단체관).*(전시회|박람회|엑스포)/;

function resolveConfigDir(): string {
  return process.env.APP_CONFIG_DIR
    ? path.resolve(process.env.APP_CONFIG_DIR)
    : path.resolve(process.cwd(), "config");
}

const mongoliaKeywordsFileSchema = z.object({
  mongoliaKeywords: z.array(z.string().trim().min(1)).min(1, "mongoliaKeywords 배열이 비어있습니다"),
});

let cachedMongoliaKeywords: string[] | null = null;

/**
 * 몽골 예외 판별용 국가/도시 키워드를 config/overseas-venue-keywords.json에서 읽어온다.
 * 코드 수정 없이 이 파일만 고쳐서 도시를 추가/삭제할 수 있게 하기 위함(loadJsonConfig.ts와 동일한 방식).
 */
export function loadMongoliaKeywords(): string[] {
  if (cachedMongoliaKeywords) return cachedMongoliaKeywords;

  const filePath = path.join(resolveConfigDir(), "overseas-venue-keywords.json");

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

  const result = mongoliaKeywordsFileSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`설정 파일 검증 실패: ${filePath}\n${details}`);
  }

  cachedMongoliaKeywords = result.data.mongoliaKeywords;
  return cachedMongoliaKeywords;
}

/** 테스트에서 캐시를 리셋하기 위한 헬퍼 */
export function _resetMongoliaKeywordsCacheForTests(): void {
  cachedMongoliaKeywords = null;
}

export interface OverseasVenueResult {
  /** 제목에 "(전시회|박람회|엑스포) + (한국관|단체관)"이 매칭되었는지 */
  isOverseasVenue: boolean;
  /** 매칭된 경우, 몽골 관련 키워드가 함께 있어 자동배제 예외 대상인지 */
  isMongolia: boolean;
  /** isMongolia가 true일 때 실제로 매칭된 키워드(디버깅/로그용) */
  matchedMongoliaKeyword: string | null;
  /** ③ 1차 필터에서 자동배제(자격미달)해야 하는지 — 매칭 && 몽골 아님 */
  shouldAutoExclude: boolean;
}

/**
 * 공고 제목 하나를 판별한다.
 *
 * 판정표:
 * - 키워드 미매치                      → shouldAutoExclude=false (표시 없음, 구조적 한계)
 * - 키워드 매치 & 몽골 아님             → shouldAutoExclude=true  (1차 필터 자동배제)
 * - 키워드 매치 & 몽골 관련             → shouldAutoExclude=false (자동배제 안 함, 🌐 플래그로 담당자 확인)
 */
export function detectOverseasVenue(title: string, mongoliaKeywords: string[]): OverseasVenueResult {
  const isOverseasVenue = OVERSEAS_VENUE_PATTERN.test(title);
  if (!isOverseasVenue) {
    return { isOverseasVenue: false, isMongolia: false, matchedMongoliaKeyword: null, shouldAutoExclude: false };
  }

  const matchedMongoliaKeyword = mongoliaKeywords.find((keyword) => title.includes(keyword)) ?? null;
  const isMongolia = matchedMongoliaKeyword !== null;

  return {
    isOverseasVenue: true,
    isMongolia,
    matchedMongoliaKeyword,
    shouldAutoExclude: !isMongolia,
  };
}
