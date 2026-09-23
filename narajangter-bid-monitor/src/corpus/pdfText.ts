import { readFileSync } from "node:fs";
import type { ExtractResult } from "./types.js";

/**
 * PDF에서 내장 텍스트 레이어를 뽑는다.
 *
 * 처음에 `strings`로 훑었을 때 텍스트가 없어 보였던 건 PDF 콘텐츠 스트림이 압축돼 있어서였다.
 * 실제로는 pdfjs가 CID 인코딩(ToUnicode CMap이 없는 경우 포함)도 내장 폰트 cmap으로
 * 복원해준다 — 아카이브 실측에서 ToUnicode 유무와 무관하게 한글이 깨짐 없이 나왔다.
 *
 * 페이지별로 돌려주는 이유는 **스캔 페이지만 골라 OCR에 넘기기 위해서**다. 수행능력평가서처럼
 * 앞쪽 서식은 텍스트, 뒤쪽 증명서는 스캔 이미지인 혼합 문서가 많은데, 통짜로 다루면
 * 107쪽을 전부 OCR하게 된다(1분 낭비) 아니면 스캔 부분을 통째로 놓치게 된다.
 */

export interface PdfPageText {
  page: number;
  text: string;
  /** 한글 음절 수. 이 페이지가 스캔본인지 판단하는 기준이 된다. */
  hangulCount: number;
}

export interface PdfTextResult extends ExtractResult {
  pageCount: number;
  pages: PdfPageText[];
}

export interface PdfTextOptions {
  maxPages?: number;
}

function countHangul(text: string): number {
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xac00 && code <= 0xd7a3) count++;
  }
  return count;
}

export async function extractPdfPages(filePath: string, options: PdfTextOptions = {}): Promise<PdfTextResult> {
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    // legacy 빌드를 쓴다 — 기본 빌드는 브라우저 전용 API(DOMMatrix 등)를 기대해서 Node에서 깨진다.
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (err) {
    return { text: "", reason: `pdfjs 로드 실패: ${String(err)}`, pageCount: 0, pages: [] };
  }

  // loadingTask를 들고 있어야 나중에 정리할 수 있다 — PDFDocumentProxy에는 destroy()가 없고
  // 로딩 태스크 쪽에 있다. 정리를 빼먹으면 워커가 살아남아 프로세스가 안 끝난다.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(filePath)),
    useSystemFonts: true,
    // 폰트·이미지 경고가 stderr를 가득 채우는 걸 막는다. 추출 결과에는 영향이 없다.
    verbosity: 0,
  });

  let doc: Awaited<typeof loadingTask.promise>;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy().catch(() => undefined);
    return { text: "", reason: `PDF 열기 실패: ${String(err)}`, pageCount: 0, pages: [] };
  }

  const limit = options.maxPages && options.maxPages > 0 ? Math.min(doc.numPages, options.maxPages) : doc.numPages;
  const pages: PdfPageText[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/[ \t ]+/g, " ")
        .trim();
      pages.push({ page: pageNumber, text, hangulCount: countHangul(text) });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }

  const joined = pages
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();

  return {
    text: joined,
    reason: joined.length === 0 ? "텍스트 레이어에서 추출된 글자가 없음 (스캔본일 수 있음)" : null,
    pageCount: doc.numPages,
    pages,
  };
}

/**
 * 한글이 이 기준보다 적은 페이지는 스캔 이미지로 본다.
 *
 * 0이 아니라 20인 이유: 스캔 페이지에도 쪽번호나 머리글 몇 글자가 텍스트로 남아 있는 경우가
 * 있어서 0으로 잡으면 스캔본을 텍스트 페이지로 오판한다. 반대로 너무 높이 잡으면 표지처럼
 * 원래 글자가 적은 텍스트 페이지까지 OCR로 보내 시간을 버린다.
 */
export const SCANNED_PAGE_HANGUL_THRESHOLD = 20;

/** 텍스트 레이어가 비어 있어 OCR이 필요한 페이지 번호들 */
export function findScannedPages(pages: PdfPageText[], threshold = SCANNED_PAGE_HANGUL_THRESHOLD): number[] {
  return pages.filter((p) => p.hangulCount < threshold).map((p) => p.page);
}
