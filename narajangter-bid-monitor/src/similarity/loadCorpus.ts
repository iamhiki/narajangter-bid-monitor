import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PastProject } from "../corpus/types.js";
import { logger } from "../logger.js";
import { SimilarityIndex } from "./index.js";

/**
 * 과거사업 코퍼스를 읽어 유사도 인덱스를 만든다. 없으면 **빈 인덱스**를 돌려준다.
 *
 * 코퍼스 파일(data/past-projects.json)은 과업지시서 본문과 발주기관 담당자 연락처가 들어 있어
 * 저장소에 올리지 않는다(.gitignore). 그래서 GitHub Actions에는 이 파일이 없다.
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
    cached = SimilarityIndex.build(projects);
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

/** 테스트에서 캐시를 비울 때 쓴다. */
export function resetSimilarityIndexCache(): void {
  cached = null;
}
