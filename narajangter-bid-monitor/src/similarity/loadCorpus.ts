import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PastProject } from "../corpus/types.js";
import { logger } from "../logger.js";
import { SimilarityIndex, type SimilarityOptions } from "./index.js";
import { workVocabulary } from "./keywordEvidence.js";
import { loadAppConfig } from "../config/loadJsonConfig.js";

/**
 * 과거사업 코퍼스를 읽어 유사도 인덱스를 만든다. 없으면 **빈 인덱스**를 돌려준다.
 *
 * 코퍼스 파일(data/past-projects.json)은 과업지시서 본문과 발주기관 담당자 연락처가 들어 있어
 * 평문은 저장소에 올리지 않는다(.gitignore). GitHub Actions는 암호화본(corpus/past-projects.enc)을
 * CORPUS_PASSPHRASE Secret으로 풀어 쓴다(scripts/corpusCrypto.ts). Secret이 없으면 파일도 없다.
 *
 * 파일이 없다고 주간 리포트가 실패하면 안 된다 — 유사도는 **부가 정보**이지 공고를 걸러내는
 * 기준이 아니기 때문이다. 없으면 싱크로율 칸이 비는 채로 나머지 파이프라인이 그대로 돈다.
 */

const DEFAULT_CORPUS_PATH = "data/past-projects.json";

let cached: SimilarityIndex | null = null;

export function loadSimilarityIndex(corpusPath?: string): SimilarityIndex {
  if (cached) return cached;

  const path = resolve(corpusPath ?? process.env.CORPUS_PATH ?? DEFAULT_CORPUS_PATH);

  if (!existsSync(path)) {
    logger.info("과거사업 코퍼스가 없어 싱크로율을 건너뜁니다", {
      path,
      안내: "npm run build:corpus -- <아카이브 폴더> 로 만들 수 있습니다",
    });
    cached = SimilarityIndex.build([]);
    return cached;
  }

  try {
    const projects = JSON.parse(readFileSync(path, "utf8")) as PastProject[];
    if (!Array.isArray(projects)) throw new Error("최상위가 배열이 아닙니다");
    cached = buildSimilarityIndex(projects);
    logger.info("과거사업 코퍼스 로드", {
      건수: projects.length,
      본문보유: projects.filter((p) => p.body.length > 0).length,
    });
  } catch (err) {
    // 코퍼스가 깨져 있어도 리포트는 나가야 한다.
    logger.warn("코퍼스를 읽지 못해 싱크로율 없이 진행합니다", { path, error: String(err) });
    cached = SimilarityIndex.build([]);
  }
  return cached;
}

/**
 * 과거사업 목록으로 인덱스를 만든다 — 실적 키워드 어휘를 늘 함께 넣는다. 화면(ui.ts)·진단 스크립트도 이걸 써야
 * 리포트와 같은 점수가 나온다 (어휘 없이 만들면 키워드 점수가 빠진 예전 점수가 된다).
 *
 * 과업지시서 본문이 없는 과거사업(196건 중 45건)은 비교 대상에서 뺀다 (2026-10-14 사용자 결정). 사업명 몇 단어로는
 * 근거 키워드가 "과학관" 하나 같은 식으로 빈약하게 나오고, 같은 기관 이름이 겹친 것만으로 1위가 되곤 했다
 * (국립부산과학관 4D 체험관 ↔ 국립부산과학관 새싹누리관).
 */
export function buildSimilarityIndex(projects: PastProject[], options: SimilarityOptions = {}): SimilarityIndex {
  const withBody = projects.filter((p) => p.body.trim().length > 0);
  return SimilarityIndex.build(withBody, { keywordVocabulary: keywordVocabulary(), ...options });
}

/** 실적 키워드 어휘 — 등록 키워드(config/keywords.json)를 못 읽어도 실적 키워드 목록만으로 돈다 */
function keywordVocabulary(): string[] {
  try {
    return workVocabulary(loadAppConfig().keywords);
  } catch {
    return workVocabulary();
  }
}

/** 테스트에서 캐시를 비울 때 쓴다. */
export function resetSimilarityIndexCache(): void {
  cached = null;
}
