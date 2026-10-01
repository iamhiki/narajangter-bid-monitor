import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { expandArchive, listAttachments, pickSpecAttachments } from "../src/api/attachments.js";
import type { NormalizedNotice } from "../src/api/types.js";

function noticeWith(files: string[]): NormalizedNotice {
  const raw: Record<string, string> = {};
  files.forEach((name, i) => {
    raw[`ntceSpecFileNm${i + 1}`] = name;
    raw[`ntceSpecDocUrl${i + 1}`] = `https://example.invalid/${i + 1}`;
  });
  return { noticeNo: "T", title: "t", businessType: "용역", sourceType: "본공고", raw } as unknown as NormalizedNotice;
}

describe("ZIP 첨부", () => {
  it("ZIP을 첨부 목록에 넣고, 과업 문서 후보로 본다 (국립중앙박물관 '제안요청서 등.zip')", () => {
    const n = noticeWith(["공고서.hwpx", "공고서.pdf", "제안요청서 등.zip"]);
    expect(listAttachments(n).map((a) => a.name)).toContain("제안요청서 등.zip");
    expect(pickSpecAttachments(n).map((a) => a.name)).toEqual(["제안요청서 등.zip"]);
  });

  it("같은 순위면 바로 붙은 문서를 ZIP보다 먼저 읽는다", () => {
    const n = noticeWith(["제안요청서 등.zip", "제안요청서.hwpx"]);
    expect(pickSpecAttachments(n).map((a) => a.name)).toEqual(["제안요청서.hwpx", "제안요청서 등.zip"]);
  });

  it("내역서 ZIP은 과업 문서로 보지 않는다", () => {
    expect(pickSpecAttachments(noticeWith(["산출내역서.zip"]))).toEqual([]);
  });

  it("ZIP을 풀어 문서만 꺼내고 과업 문서를 앞에 둔다", () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-"));
    const zipPath = join(dir, "a.zip");
    writeFileSync(
      zipPath,
      zipSync({
        "02_전시기획안.pdf": strToU8("%PDF-1.4"),
        "03_작품리스트.xlsx": strToU8("xlsx"),
        "01_제안요청서.hwpx": strToU8("PK"),
      })
    );
    const docs = expandArchive(zipPath, "제안요청서 등.zip");
    expect(docs.map((d) => d.name)).toEqual(["제안요청서 등.zip › 01_제안요청서.hwpx", "제안요청서 등.zip › 02_전시기획안.pdf"]);
    expect(readFileSync(docs[0]!.path, "utf8")).toBe("PK");
    // 두 번째 호출은 풀어 둔 것을 그대로 쓴다
    expect(expandArchive(zipPath, "제안요청서 등.zip").map((d) => d.path)).toEqual(docs.map((d) => d.path));
  });
});
