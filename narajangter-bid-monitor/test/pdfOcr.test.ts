import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectFormat, extractDocumentText } from "../src/corpus/extractText.js";
import { isOcrAvailable, joinOcrPages, ocrPdf } from "../src/corpus/ocr.js";
import { findScannedPages, SCANNED_PAGE_HANGUL_THRESHOLD, type PdfPageText } from "../src/corpus/pdfText.js";

const tmp = mkdtempSync(join(tmpdir(), "corpus-test-"));

function writeFixture(name: string, bytes: Buffer | string): string {
  const path = join(tmp, name);
  writeFileSync(path, bytes);
  return path;
}

describe("detectFormat", () => {
  it("매직바이트로 PDF를 알아본다", () => {
    expect(detectFormat(writeFixture("a.pdf", "%PDF-1.7\n..."))).toBe("pdf");
  });

  it("확장자가 .hwp여도 내용이 zip이면 hwpx로 본다", () => {
    // 아카이브의 2025_강릉아레나 제안요청서가 실제로 이런 파일이었다.
    expect(detectFormat(writeFixture("b.hwp", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])))).toBe("hwpx");
  });

  it("확장자가 .pdf여도 내용이 OLE면 hwp로 본다", () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(detectFormat(writeFixture("c.pdf", ole))).toBe("hwp");
  });

  it("내용을 못 읽으면 확장자로 떨어진다", () => {
    expect(detectFormat(join(tmp, "없는파일.pdf"))).toBe("pdf");
    expect(detectFormat(join(tmp, "없는파일.xlsx"))).toBe("unknown");
  });
});

describe("findScannedPages", () => {
  const pages: PdfPageText[] = [
    { page: 1, text: "표지", hangulCount: 2 },
    { page: 2, text: "본문이 충분히 긴 페이지".repeat(5), hangulCount: 60 },
    { page: 3, text: "- 17 -", hangulCount: 0 },
  ];

  it("한글이 임계값 미만인 페이지만 고른다", () => {
    // 스캔 페이지에도 쪽번호가 텍스트로 남는 경우가 있어 0이 아니라 20을 기준으로 쓴다.
    expect(SCANNED_PAGE_HANGUL_THRESHOLD).toBe(20);
    expect(findScannedPages(pages)).toEqual([1, 3]);
  });

  it("임계값을 바꿀 수 있다", () => {
    expect(findScannedPages(pages, 1)).toEqual([3]);
  });

  it("전부 텍스트면 빈 배열", () => {
    expect(findScannedPages([{ page: 1, text: "가".repeat(50), hangulCount: 50 }])).toEqual([]);
  });
});

describe("joinOcrPages", () => {
  it("페이지 순서대로 합치고 빈 페이지는 건너뛴다", () => {
    const joined = joinOcrPages({
      pageCount: 3,
      pages: [
        { page: 3, text: "셋" },
        { page: 1, text: "하나" },
        { page: 2, text: "" },
      ],
      error: null,
      fromCache: false,
    });
    expect(joined).toBe("하나\n셋");
  });
});

describe("ocrPdf", () => {
  it("OCR을 쓸 수 없는 환경에서는 예외 대신 사유를 돌려준다", async () => {
    // GitHub Actions(ubuntu)에서 파이프라인이 죽으면 안 된다.
    const result = await ocrPdf(writeFixture("scan.pdf", "%PDF-1.4\n"), { cacheDir: null });
    if (isOcrAvailable()) {
      // Windows에서는 실제로 시도하므로 깨진 PDF에 대한 실패 사유가 담긴다.
      expect(result.error).not.toBeNull();
    } else {
      expect(result.error).toContain("OCR 미지원 플랫폼");
      expect(result.pages).toEqual([]);
    }
  });
});

describe("extractDocumentText (PDF)", () => {
  it("깨진 PDF에서도 예외를 던지지 않는다", async () => {
    const result = await extractDocumentText(writeFixture("broken.pdf", "%PDF-1.4\n깨진내용"));
    expect(result.text).toBe("");
    expect(result.reason).toBeTruthy();
  });

  it("ocr: force인데 OCR이 불가능하면 사유를 남긴다", async () => {
    if (isOcrAvailable()) return; // Windows에서는 실제 경로를 타므로 이 단언이 의미 없다.
    const result = await extractDocumentText(writeFixture("force.pdf", "%PDF-1.4\n"), { ocr: "force" });
    expect(result.reason).toContain("OCR");
  });

  it("지원하지 않는 형식은 사유를 남긴다", async () => {
    const result = await extractDocumentText(writeFixture("d.xlsx", "PK-not-really"));
    expect(result.text).toBe("");
  });
});
