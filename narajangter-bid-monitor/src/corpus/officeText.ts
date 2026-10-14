import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import type { ExtractResult } from "./types.js";

/**
 * 워드(.docx)·엑셀(.xlsx)에서 글자를 뽑는다.
 *
 * 왜 필요한가 (2026-10-13 실측): 과업지시서가 없어 제목만으로 싱크로율을 매긴 공고 25건 중 대부분이
 * 공사 공고였고, 과업 내용은 "공내역서.xlsx"(공종·품명 목록)나 "시방서.docx"에만 있었다.
 * 둘 다 hwpx처럼 zip 안 XML이라 태그만 걷으면 된다.
 */

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** zip 안 항목 이름으로 오피스 문서 종류를 가린다. hwpx도 zip이라 확장자·매직바이트만으로는 구분이 안 된다. */
export function officeKind(entries: string[]): "docx" | "xlsx" | null {
  if (entries.includes("word/document.xml")) return "docx";
  if (entries.some((e) => e.startsWith("xl/"))) return "xlsx";
  return null;
}

export function extractDocxText(filePath: string): ExtractResult {
  try {
    const files = unzipSync(new Uint8Array(readFileSync(filePath)), { filter: (f) => f.name === "word/document.xml" });
    const xml = files["word/document.xml"];
    if (!xml) return { text: "", reason: "docx 본문(word/document.xml)이 없음" };
    const text = decodeEntities(
      new TextDecoder()
        .decode(xml)
        .replace(/<\/w:p>/g, "\n")
        .replace(/<w:(?:tab|br)\b[^>]*\/>|<\/w:tc>/g, " ")
        .replace(/<[^>]+>/g, "")
    );
    return { text, reason: null };
  } catch (err) {
    return { text: "", reason: `docx 열기 실패: ${String(err)}` };
  }
}

/**
 * 엑셀은 글자 칸만 모은다 — 내역서의 단가·수량 숫자는 과업 내용이 아니다.
 * 글자 칸은 xl/sharedStrings.xml에 중복 없이 한 번씩 모여 있어 그것만 읽으면 공종·품명·규격 목록이 된다.
 * 숫자만 있는 칸, "식", "EA" 같은 단위 한두 글자는 뺀다.
 */
export function extractXlsxText(filePath: string): ExtractResult {
  try {
    const files = unzipSync(new Uint8Array(readFileSync(filePath)), { filter: (f) => f.name === "xl/sharedStrings.xml" });
    const xml = files["xl/sharedStrings.xml"];
    if (!xml) return { text: "", reason: "엑셀에 글자 칸이 없음" };
    const cells = [...new TextDecoder().decode(xml).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      decodeEntities([...m[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")).trim()
    );
    const kept = cells.filter((c) => /[가-힣]{2,}|[A-Za-z]{3,}/.test(c));
    return { text: kept.join("\n"), reason: kept.length === 0 ? "엑셀 글자 칸에 내용이 없음" : null };
  } catch (err) {
    return { text: "", reason: `xlsx 열기 실패: ${String(err)}` };
  }
}
