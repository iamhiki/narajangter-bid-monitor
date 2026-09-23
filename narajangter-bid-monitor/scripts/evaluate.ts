import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PastProject } from "../src/corpus/types.js";
import { SimilarityIndex, type SimilarityOptions } from "../src/similarity/index.js";

/**
 * 싱크로율 성능 측정 (④단계 평가 도구).
 *
 *   npm run eval
 *   npm run eval -- --minShared=1 --shrinkage=1     # 설정을 바꿔 비교
 *
 * **왜 필요한가.** 지금까지 "유사 5건 / 무관 5건"을 손으로 골라 비교했는데, 그건 고른
 * 사람의 감을 재는 것이지 성능이 아니다. 정답이 정해진 문제를 풀려야 개선 여부를 말할 수 있다.
 *
 * **정답을 어디서 얻는가.** 코퍼스에는 같은 사업이 연도를 달리해 여러 번 들어와 있다
 * (재공고·후속 발주). 예: `2025 횡성목재문화체험장` ↔ `2026 횡성 목재문화체험장 전시연출
 * 및 제작·설치`. 사람이 라벨을 붙이지 않아도 "이 둘은 같은 사업"이라는 정답이 이미 있는 셈이다.
 * 한쪽 이름으로 질의했을 때 다른 쪽이 상위에 오는지를 보면 검색 성능이 나온다.
 *
 * **한계.** 쌍이 9개뿐이라 작은 표본이고, "같은 사업"이라 원래 쉬운 문제다. 담당자 O/X
 * 판정이 쌓이면 그게 훨씬 나은 평가 세트가 된다 — 이 도구는 그때까지 쓰는 임시 잣대다.
 */

const CORPUS_PATH = resolve(process.env.CORPUS_PATH ?? "data/past-projects.json");

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const overrides: SimilarityOptions = {};
if (flag("minShared")) overrides.minSharedNgrams = Number(flag("minShared"));
if (flag("shrinkage")) overrides.missingBodyShrinkage = Number(flag("shrinkage"));
if (flag("nameWeight")) overrides.nameWeight = Number(flag("nameWeight"));
if (flag("bodyWeight")) overrides.bodyWeight = Number(flag("bodyWeight"));
if (flag("k")) overrides.saturationK = Number(flag("k"));

let projects: PastProject[];
try {
  projects = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as PastProject[];
} catch {
  console.error(`코퍼스를 읽지 못했습니다: ${CORPUS_PATH}`);
  console.error("먼저 실행하세요:  npm run build:corpus -- <아카이브 폴더 경로>");
  process.exit(1);
}

/** 이름 정규화 — 연도·기호를 빼고 견준다. */
function normalize(name: string): string {
  return name.replace(/[^0-9A-Za-z가-힣]/g, "").replace(/^(19|20)?\d{2}년?/, "");
}

/**
 * 같은 사업으로 보이는 쌍을 찾는다.
 *
 * 한쪽 이름이 다른 쪽에 통째로 들어 있으면 같은 사업으로 본다
 * (`횡성목재문화체험장` ⊂ `횡성목재문화체험장전시연출및제작설치`).
 * 8자 이상이면 앞 8자만 일치해도 인정한다 — 뒤에 붙는 수식어가 발주 연도마다 달라진다.
 */
function findPairs(list: PastProject[]): [PastProject, PastProject][] {
  const pairs: [PastProject, PastProject][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let k = i + 1; k < list.length; k++) {
      const a = normalize(list[i]!.name);
      const b = normalize(list[k]!.name);
      if (a.length < 6 || b.length < 6) continue;
      const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
      if (longer.includes(shorter) || (shorter.length >= 8 && longer.includes(shorter.slice(0, 8)))) {
        pairs.push([list[i]!, list[k]!]);
      }
    }
  }
  return pairs;
}

const pairs = findPairs(projects);

/**
 * 쌍을 묶어 **같은 사업 무리**로 만든다 (합집합 찾기).
 *
 * 처음엔 쌍 단위로 채점했는데 그게 틀렸다. `이청준문학관`은 코퍼스에 3건
 * (2025 실시설계용역 / 2025 미백 이청준 문학관 / 2026 이청준문학관), `횡성목재문화체험장`도
 * 3건이 있다. 한 건으로 질의하면 정답이 **둘 이상**인데, 쌍 단위 채점은 그중 하나만
 * 정답으로 쳐서 나머지를 맞혔는데도 오답으로 셌다. 실제로 "실패" 7건이 전부 그 경우였다.
 *
 * 무리 안의 **아무 항목이나** 1위면 맞힌 것으로 본다.
 */
function buildClusters(list: PastProject[], found: [PastProject, PastProject][]): Map<string, string> {
  const parent = new Map<string, string>(list.map((p) => [p.id, p.id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const [a, b] of found) parent.set(find(a.id), find(b.id));
  return new Map(list.map((p) => [p.id, find(p.id)]));
}

const cluster = buildClusters(projects, pairs);
const members = new Map<string, string[]>();
for (const [id, root] of cluster) members.set(root, [...(members.get(root) ?? []), id]);
const evalTargets = projects.filter((p) => (members.get(cluster.get(p.id)!) ?? []).length > 1);

const index = SimilarityIndex.build(projects, overrides);

interface Outcome {
  query: string;
  answer: string;
  rank: number | null;
  score: number;
}

const outcomes: Outcome[] = [];
for (const from of evalTargets) {
  const sameCluster = new Set(members.get(cluster.get(from.id)!) ?? []);
  sameCluster.delete(from.id);

  const ranked = index.findSimilar(from.name, projects.length).top.filter((m) => m.id !== from.id);
  const position = ranked.findIndex((m) => sameCluster.has(m.id));
  outcomes.push({
    query: from.name,
    answer: [...sameCluster].map((id) => projects.find((p) => p.id === id)!.name).join(" | "),
    rank: position >= 0 ? position + 1 : null,
    score: position >= 0 ? ranked[position]!.score : 0,
  });
}

const hitsAt = (k: number): number => outcomes.filter((o) => o.rank !== null && o.rank <= k).length;
const mrr =
  outcomes.reduce((sum, o) => sum + (o.rank ? 1 / o.rank : 0), 0) / Math.max(outcomes.length, 1);

const settings = [
  `최소공통 n-gram ${overrides.minSharedNgrams ?? "기본"}`,
  `본문없음 축소 ${overrides.missingBodyShrinkage ?? "기본"}`,
  `가중치 ${overrides.nameWeight ?? "기본"}/${overrides.bodyWeight ?? "기본"}`,
].join(" · ");

console.log(`코퍼스 ${projects.length}건 · 같은 사업 무리 ${new Set([...members].filter(([,v])=>v.length>1).map(([k])=>k)).size}개 → 질의 ${outcomes.length}회`);
console.log(`설정: ${settings}\n`);
console.log(`  Recall@1  ${hitsAt(1)}/${outcomes.length}  (${((hitsAt(1) / outcomes.length) * 100).toFixed(0)}%)`);
console.log(`  Recall@3  ${hitsAt(3)}/${outcomes.length}  (${((hitsAt(3) / outcomes.length) * 100).toFixed(0)}%)`);
console.log(`  Recall@10 ${hitsAt(10)}/${outcomes.length}  (${((hitsAt(10) / outcomes.length) * 100).toFixed(0)}%)`);
console.log(`  MRR       ${mrr.toFixed(3)}`);

const misses = outcomes.filter((o) => o.rank === null || o.rank > 3);
if (misses.length > 0) {
  console.log(`\n3위 안에 못 들어온 ${misses.length}건:`);
  for (const m of misses) {
    console.log(`  "${m.query.slice(0, 34)}"`);
    console.log(`     정답 "${m.answer.slice(0, 34)}" → ${m.rank ? `${m.rank}위` : "아예 안 나옴"}`);
  }
}
