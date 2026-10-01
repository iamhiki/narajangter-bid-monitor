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
      const text = joinTextItems(content.items.flatMap((item) => ("str" in item ? [item as PdfTextItem] : [])));
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

/** pdfjs 텍스트 조각 — 필요한 필드만. transform = [a, b, c, d, x, y] */
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

const HANGUL = /[가-힣]/;
/** 항목 기호로 시작하는 조각 — "가.", "1.", "1)", "(1)", "□", "○", "-", "※" */
const ITEM_START = /^\s*(?:[가-하][.)]|\d{1,2}[.)](?!\d)|\(\d{1,2}\)|[□■○●◦▪※•❍◆◇▶\-])/;

/**
 * pdfjs 텍스트 조각을 이어 붙인다.
 *
 * 예전에는 조각마다 무조건 띄어쓰기를 넣었다. PDF는 한 낱말을 여러 조각으로 쪼개 저장하고, 한글 문서는
 * 줄 끝에서 낱말 중간을 끊어 다음 줄로 넘기는 경우가 많아서 "전시 콘 텐츠", "육 성하고", "체계 적으로"처럼
 * 낱말이 끊긴 채 뽑혔다(2026-10-01 고성 마동호 습지센터 과업지시서). 그러면 "유물 운송" 같은 문구 검사와
 * 과업 요약이 깨진다. 이제 조각의 위치를 보고 정한다:
 *  · 같은 줄: 앞 조각 끝과 이 조각 사이가 글자 크기의 0.2배보다 벌어졌을 때만 띄운다.
 *  · 줄이 바뀜: 앞 줄이 오른쪽 끝까지 찼고(=폭 때문에 넘어간 줄) 양쪽이 한글이면 붙인다(낱말 중간 끊김).
 *    오른쪽 끝까지 안 찬 줄은 문단이 끝난 것이라 줄바꿈으로 둔다.
 * (싱크로율은 띄어쓰기를 지우고 비교하므로 이 변경으로 점수는 바뀌지 않는다 — similarity/tokenize.ts)
 */
export function joinTextItems(items: PdfTextItem[]): string {
  const parts = items.filter((it) => it.str.length > 0);
  if (parts.length === 0) return "";
  const sizeOf = (it: PdfTextItem) => Math.abs(it.transform[3] ?? 0) || Math.hypot(it.transform[2] ?? 0, it.transform[3] ?? 0) || 10;
  const rightEdge = Math.max(...parts.map((it) => (it.transform[4] ?? 0) + it.width));
  let out = "";
  let prev: PdfTextItem | null = null;
  for (const it of parts) {
    if (!prev) {
      out = it.str;
      prev = it;
      continue;
    }
    const size = Math.max(sizeOf(prev), sizeOf(it));
    const prevEnd = (prev.transform[4] ?? 0) + prev.width;
    const sameLine = Math.abs((it.transform[5] ?? 0) - (prev.transform[5] ?? 0)) < size * 0.5;
    let sep: string;
    if (sameLine) {
      sep = (it.transform[4] ?? 0) - prevEnd > size * 0.2 ? " " : "";
    } else {
      const lineFull = rightEdge - prevEnd < size * 2;
      // 다음 줄이 항목 기호로 시작하면 새 항목이다 — "…높이고자 함" + "다. 창의적이고"가 "함다."로 붙지 않게
      const newItem = ITEM_START.test(it.str);
      const glue = lineFull && !newItem && HANGUL.test(out.slice(-1)) && HANGUL.test(it.str.charAt(0));
      sep = glue ? "" : lineFull && !newItem ? " " : "\n";
    }
    // 조각 자체가 공백으로 끝나거나 시작하면 띄어쓰기를 겹치지 않는다
    if (sep === " " && (/\s$/.test(out) || /^\s/.test(it.str))) sep = "";
    out += sep + it.str;
    prev = it;
  }
  return out.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();
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
