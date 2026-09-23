import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { detectFormat, extractDocumentText, type OcrMode } from "../src/corpus/extractText.js";
import { isOcrAvailable } from "../src/corpus/ocr.js";
import { extractPdfPages, findScannedPages } from "../src/corpus/pdfText.js";

/**
 * 문서 하나를 읽어 텍스트로 뽑는다 (hwp / hwpx / pdf).
 *
 *   npm run read -- "…\20260224_과업지시서.hwp"
 *   npm run read -- "…\사업수행능력평가서.pdf" --ocr          # 스캔 페이지만 OCR
 *   npm run read -- "…\증명서.pdf" --ocr=force --pages=5      # 5쪽까지 전부 OCR
 *   npm run read -- "…\평가서.pdf" --ocr --out=결과.txt
 *
 * 코퍼스 빌드와 별개로 **아무 문서나 열어보는** 용도다. 수행능력평가서에서 실적표나
 * 직접생산확인증명서를 찾아보는 것처럼, 아직 파이프라인에 넣을지 정하지 않은 탐색용.
 */

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const ocrFlag = args.find((a) => a.startsWith("--ocr"));
const outFlag = args.find((a) => a.startsWith("--out="));
const pagesFlag = args.find((a) => a.startsWith("--pages="));

if (!filePath) {
  console.error("사용법: npm run read -- <파일 경로> [--ocr[=auto|force]] [--pages=N] [--out=파일]");
  process.exit(1);
}

const ocrMode: OcrMode = ocrFlag ? ((ocrFlag.split("=")[1] as OcrMode) ?? "auto") : "off";
const maxPages = pagesFlag ? Number(pagesFlag.split("=")[1]) : 0;
const target = resolve(filePath);
const format = detectFormat(target);

console.log(`파일: ${basename(target)}`);
console.log(`형식: ${format}${format === "pdf" ? ` · OCR ${ocrMode}` : ""}`);
if (format === "pdf" && ocrMode !== "off" && !isOcrAvailable()) {
  console.log("주의: 이 환경에서는 OCR을 쓸 수 없습니다 (Windows 전용). 텍스트 레이어만 읽습니다.");
}

// PDF는 어느 페이지가 스캔인지 미리 보여준다 — OCR 비용을 가늠할 수 있어야 한다.
if (format === "pdf") {
  const layer = await extractPdfPages(target, { maxPages });
  const scanned = findScannedPages(layer.pages);
  console.log(
    `쪽수: ${layer.pageCount}${maxPages > 0 ? ` (앞 ${Math.min(maxPages, layer.pageCount)}쪽만 확인)` : ""}` +
      ` · 텍스트 ${layer.pages.length - scanned.length}쪽 · 스캔 추정 ${scanned.length}쪽`
  );
  if (scanned.length > 0 && ocrMode === "off") {
    console.log(`  → 스캔 ${scanned.length}쪽을 읽으려면 --ocr 를 붙이세요 (약 ${(scanned.length * 0.6).toFixed(0)}초 예상)`);
  }
}

const started = Date.now();
const result = await extractDocumentText(target, { ocr: ocrMode, maxPages });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const hangul = [...result.text].filter((c) => {
  const code = c.codePointAt(0) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3;
}).length;

console.log(`\n추출 ${result.text.length.toLocaleString("ko-KR")}자 (한글 ${hangul.toLocaleString("ko-KR")}자) · ${elapsed}초`);
if (result.reason) console.log(`비고: ${result.reason}`);

if (result.text.length === 0) process.exit(1);

if (outFlag) {
  const out = resolve(outFlag.slice("--out=".length));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.text, "utf8");
  console.log(`\n저장: ${out}`);
} else {
  console.log("\n--- 앞 1,200자 ---");
  console.log(result.text.slice(0, 1200));
  if (result.text.length > 1200) console.log(`\n… (--out=파일 로 전체 저장)`);
}
