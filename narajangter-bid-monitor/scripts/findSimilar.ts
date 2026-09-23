import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PastProject } from "../src/corpus/types.js";
import { SimilarityIndex } from "../src/similarity/index.js";

/**
 * 공고 제목을 넣으면 가장 비슷한 과거사업을 보여준다 — ④단계 프로토타입 확인용.
 *
 *   npm run similar -- "정선군 복합문화센터 공간디자인 및 전시물 제작설치"
 *
 * 인자를 주지 않으면 코퍼스에 있는 사업명 몇 개로 자가 점검(self-check)을 돌린다.
 * 자기 자신이 1위로 안 나오면 토크나이저나 불용어 설정이 잘못된 것이다.
 */

const CORPUS_PATH = resolve(process.env.CORPUS_PATH ?? "data/past-projects.json");

let projects: PastProject[];
try {
  projects = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as PastProject[];
} catch {
  console.error(`코퍼스를 읽지 못했습니다: ${CORPUS_PATH}`);
  console.error("먼저 실행하세요:  npm run build:corpus -- <아카이브 폴더 경로>");
  process.exit(1);
}

const index = SimilarityIndex.build(projects);
console.log(`코퍼스 ${index.size}건 로드 완료\n`);

/** 실제 나라장터에 올라올 법한 제목들. 코퍼스에 그대로 있는 문자열이 아니어야 의미가 있다. */
const SAMPLE_QUERIES: string[] = [];

const query = process.argv.slice(2).join(" ").trim();

if (query.length > 0) {
  report(query, 5);
} else {
  console.log("── 자가 점검: 코퍼스의 사업명을 그대로 질의했을 때 자기 자신이 1위인가 ──\n");
  let correct = 0;
  for (const project of projects) {
    const result = index.findSimilar(project.name, 1);
    if (result.top[0]?.id === project.id) correct++;
  }
  console.log(`  ${correct}/${projects.length} (${((correct / projects.length) * 100).toFixed(0)}%)\n`);

  console.log("── 샘플 질의 ──");
  for (const sample of SAMPLE_QUERIES) report(sample, 3);
}


function report(title: string, limit: number): void {
  const result = index.findSimilar(title, limit);
  console.log(`\n▸ "${title}"`);
  console.log(`  최고 유사도: ${result.maxScore.toFixed(3)}`);
  for (const [rank, match] of result.top.entries()) {
    const body = match.bodyScore === null ? "본문없음" : `본문 ${match.bodyScore.toFixed(3)}`;
    console.log(
      `   ${rank + 1}. ${match.score.toFixed(3)}  ${match.year} ${match.name.slice(0, 50)}` +
        `\n      (사업명 ${match.nameScore.toFixed(3)} · ${body})`
    );
  }
}
