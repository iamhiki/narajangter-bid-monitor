import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OcrMode } from "../src/corpus/extractText.js";
import { isOcrAvailable } from "../src/corpus/ocr.js";
import { scanArchive } from "../src/corpus/scanArchive.js";

/**
 * 과거 공고 아카이브 폴더 → data/past-projects.json
 *
 *   npm run build:corpus -- "C:\\Users\\WEBDEV\\Desktop\\지일 과거 공고"
 *
 * 아카이브는 회사 서버/개인 PC에 있고 용량이 크므로 저장소에 넣지 않는다. 이 스크립트가
 * 만든 JSON만 저장소에 들어가고, 그게 ④단계 유사도 스코어링의 입력이 된다.
 * (JSON에는 과업지시서 본문이 들어가므로, 대외비가 섞여 있다면 .gitignore 처리할 것)
 */

const args = process.argv.slice(2);
const ocrFlag = args.find((a) => a.startsWith("--ocr"));
const positional = args.filter((a) => !a.startsWith("--"));

const ARCHIVE_ROOT = positional[0] ?? process.env.ARCHIVE_ROOT;
const OUTPUT = resolve(positional[1] ?? "data/past-projects.json");

/** --ocr / --ocr=auto / --ocr=force / (없으면) off */
const ocrMode: OcrMode = ocrFlag ? ((ocrFlag.split("=")[1] as OcrMode) ?? "auto") : "off";

if (!ARCHIVE_ROOT) {
  console.error("사용법: npm run build:corpus -- <아카이브 폴더 경로> [출력 JSON 경로] [--ocr[=auto|force]]");
  console.error('예:    npm run build:corpus -- "C:\\Users\\WEBDEV\\Desktop\\지일 과거 공고"');
  console.error('       npm run build:corpus -- "…\\지일 과거 공고" --ocr   (PDF 스캔 페이지도 읽기)');
  process.exit(1);
}

if (!["off", "auto", "force"].includes(ocrMode)) {
  console.error(`--ocr 값이 잘못됐습니다: ${ocrMode} (auto 또는 force)`);
  process.exit(1);
}

const archiveRoot = resolve(ARCHIVE_ROOT);
console.log(`아카이브: ${archiveRoot}`);
if (ocrMode !== "off") {
  console.log(`OCR: ${ocrMode} · ${isOcrAvailable() ? "사용 가능 (Windows 내장)" : "이 환경에서는 사용 불가 — 텍스트 레이어만 읽습니다"}`);
}

const started = Date.now();
const { projects, withoutBody } = await scanArchive(archiveRoot, {
  ocr: ocrMode,
  onProgress: (done, total, name) => {
    process.stdout.write(`\r  ${done}/${total} 처리 중… ${name.slice(0, 40)}`.padEnd(80));
  },
});
process.stdout.write("\r".padEnd(82) + "\r");

if (projects.length === 0) {
  console.error("사업 폴더를 하나도 찾지 못했습니다. 폴더 구조가 <연도>/<사업명>/ 인지 확인하세요.");
  process.exit(1);
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(projects, null, 2), "utf8");

const withBody = projects.length - withoutBody.length;
const withBudget = projects.filter((p) => p.budgetAmount != null).length;
const withOfficialName = projects.filter((p) => p.officialName != null).length;
const byYear = new Map<number, number>();
for (const p of projects) byYear.set(p.year, (byYear.get(p.year) ?? 0) + 1);

console.log(`\n완료 (${((Date.now() - started) / 1000).toFixed(1)}초)`);
console.log(`  사업 ${projects.length}건 → ${OUTPUT}`);
console.log(`  연도별: ${[...byYear].sort().map(([y, c]) => `${y}년 ${c}건`).join(" · ")}`);
console.log(`  본문 확보: ${withBody}건 (${pct(withBody, projects.length)})`);
console.log(`  정식 사업명 추출: ${withOfficialName}건 (${pct(withOfficialName, projects.length)})`);
console.log(`  사업비 추출: ${withBudget}건 (${pct(withBudget, projects.length)})`);

if (withoutBody.length > 0) {
  console.log(`\n본문 없음 ${withoutBody.length}건 (폴더명만으로 비교됩니다):`);
  for (const item of withoutBody) {
    console.log(`  - ${item.id}  …  ${item.reason.slice(0, 70)}`);
  }
}

function pct(part: number, total: number): string {
  return `${((part / total) * 100).toFixed(0)}%`;
}
