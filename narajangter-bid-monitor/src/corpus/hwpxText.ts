import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import type { ExtractResult } from "./types.js";

/**
 * 한글 XML 문서(.hwpx)에서 본문 텍스트를 뽑는다.
 *
 * .hwpx는 zip이고 본문이 Contents/section{N}.xml에 평문 XML로 들어 있어서
 * .hwp보다 훨씬 다루기 쉽다. 태그만 걷어내면 본문이 나온다.
 */

/**
 * 그림 개체에는 캡션 대신 편집기가 심어둔 메타데이터가 붙는다:
 * "그림입니다. / 원본 그림의 이름: xxx.png / 원본 그림의 크기: 가로 1958pixel ... /
 *  프로그램 이름 : Adobe ImageReady". 문서마다 똑같이 반복되는 문구라, 그대로 두면
 * 서로 다른 사업끼리 이 문구 때문에 유사해 보이는 가짜 유사도가 생긴다. 먼저 지운다.
 */
const IMAGE_NOISE_PATTERNS = [
  /그림입니다\./g,
  /원본 그림의 이름\s*:[^\n]*/g,
  /원본 그림의 크기\s*:[^\n]*/g,
  /프로그램 이름\s*:[^\n]*/g,
  /사진 찍은 날짜\s*:[^\n]*/g,
];

export function stripImageNoise(text: string): string {
  let out = text;
  for (const pattern of IMAGE_NOISE_PATTERNS) out = out.replace(pattern, " ");
  return out;
}

/** XML 태그 제거 + 엔티티 복원. 본문 텍스트만 남긴다. */
export function xmlToText(xml: string): string {
  return xml
    .replace(/<\?xml[^>]*\?>/g, " ")
    // 문단/줄바꿈 태그는 공백이 아니라 줄바꿈으로 바꿔야 문단이 붙어버리지 않는다.
    .replace(/<\/hp:p>/g, "\n")
    .replace(/<hp:lineBreak\b[^>]*\/>/g, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

export function extractHwpxText(filePath: string): ExtractResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(readFileSync(filePath));
  } catch (err) {
    return { text: "", reason: `hwpx(zip) 읽기 실패: ${String(err)}` };
  }

  const sectionNames = Object.keys(files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort();

  const decoder = new TextDecoder("utf-8");

  if (sectionNames.length === 0) {
    // hwp와 같은 이유로 미리보기 텍스트를 차선책으로 쓴다.
    const preview = files["Preview/PrvText.txt"];
    if (preview) {
      return { text: decoder.decode(preview), reason: "본문 섹션 없음 — 미리보기 텍스트 사용" };
    }
    return { text: "", reason: "Contents/section*.xml과 PrvText가 모두 없음" };
  }

  const parts: string[] = [];
  for (const name of sectionNames) {
    const data = files[name];
    if (!data) continue;
    parts.push(xmlToText(decoder.decode(data)));
  }

  const text = stripImageNoise(parts.join("\n")).trim();
  if (text.length === 0) return { text: "", reason: "본문 XML에서 추출된 글자가 없음" };
  return { text, reason: null };
}
