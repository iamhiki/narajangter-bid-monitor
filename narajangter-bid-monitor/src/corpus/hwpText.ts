import { inflateRawSync } from "node:zlib";
import CFB from "cfb";
import type { ExtractResult } from "./types.js";

/**
 * 한글 바이너리 문서(.hwp, HWP 5.0)에서 본문 텍스트를 뽑는다.
 *
 * .hwp는 OLE 복합문서(CFB)라 zip이 아니다. 내부에 BodyText/Section{N} 스트림이 있고,
 * 파일 헤더의 압축 플래그가 켜져 있으면 각 섹션이 **raw deflate**(zlib 헤더 없음)로 눌려 있다.
 * 압축을 풀면 4바이트 레코드 헤더가 반복되는 스트림이 나오고, 본문 글자는 그중
 * HWPTAG_PARA_TEXT(태그 67) 레코드에 UTF-16LE로 들어 있다.
 *
 * 외부 변환기(한컴오피스, LibreOffice)를 깔지 않고 순수 Node로 돌리기 위해 직접 파싱한다 —
 * GitHub Actions에서도 그대로 돌아가야 하기 때문이다.
 */

const HWPTAG_PARA_TEXT = 67;

/**
 * HWP 본문의 제어 문자 처리.
 *
 * 본문 스트림에는 글자 사이에 표·그림·각주 같은 개체를 가리키는 제어 문자가 섞여 있다.
 * 이걸 걸러내지 않으면 개체의 내부 식별자("tbl ", "gso ", "$rec" 등)가 UTF-16으로 잘못
 * 읽혀 `氠瑢` 같은 깨진 글자가 본문에 박힌다 — 유사도 계산에 그대로 잡음으로 들어간다.
 *
 * HWP 규격상 제어 문자는 세 종류이고, 확장/인라인 제어는 **자기 자신 포함 8글자(WCHAR)**를
 * 차지하므로 통째로 건너뛰어야 한다.
 */
const CHAR_CONTROLS = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);

function decodeParaText(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i + 1 < buf.length) {
    const ch = buf.readUInt16LE(i);
    if (ch > 31) {
      out += String.fromCharCode(ch);
      i += 2;
      continue;
    }
    if (ch === 10 || ch === 13) {
      out += "\n";
      i += 2;
      continue;
    }
    if (CHAR_CONTROLS.has(ch)) {
      i += 2;
      continue;
    }
    // 확장/인라인 제어: 자기 자신 + 6글자 + 닫는 글자 = 8 WCHAR = 16바이트
    i += 16;
  }
  return out;
}

interface CfbEntry {
  content: Uint8Array | number[];
}

function readStream(container: CFB.CFB$Container, path: string): Buffer | null {
  const index = container.FullPaths.indexOf(path);
  if (index < 0) return null;
  const entry = container.FileIndex[index] as CfbEntry | undefined;
  if (!entry?.content) return null;
  return Buffer.from(entry.content as Uint8Array);
}

/**
 * 압축 플래그가 켜져 있으면 raw deflate를 풀고, 아니면 원본 그대로 쓴다.
 * 플래그를 믿되 실패하면 비압축으로 재시도한다 — 한글 버전에 따라 플래그와 실제가
 * 어긋나는 파일이 섞여 있어서, 여기서 예외를 던지면 그 사업 1건이 통째로 빠진다.
 */
function decompressSection(section: Buffer, compressed: boolean): Buffer | null {
  if (compressed) {
    try {
      return inflateRawSync(section);
    } catch {
      return section;
    }
  }
  return section;
}

export function extractHwpText(filePath: string): ExtractResult {
  let container: CFB.CFB$Container;
  try {
    container = CFB.read(filePath, { type: "file" });
  } catch (err) {
    return { text: "", reason: `CFB 읽기 실패: ${String(err)}` };
  }

  const header = readStream(container, "Root Entry/FileHeader");
  // 파일 헤더 32바이트는 시그니처, 그 다음 4바이트가 버전, 36번째부터가 속성 비트.
  const compressed = header != null && header.length >= 40 ? (header.readUInt32LE(36) & 1) === 1 : true;

  const sections = container.FullPaths.filter((p) => /^Root Entry\/BodyText\/Section\d+$/.test(p)).sort();

  if (sections.length === 0) {
    // 본문 섹션을 못 찾으면 미리보기 텍스트로라도 떨어진다. PrvText는 비압축 UTF-16LE이고
    // 보통 문서 앞 1~2쪽(과업명·사업비·추진배경)이 들어 있어 유사도 용도로는 충분히 쓸 만하다.
    const preview = readStream(container, "Root Entry/PrvText");
    if (preview) {
      return { text: preview.toString("utf16le"), reason: "본문 섹션 없음 — 미리보기 텍스트 사용" };
    }
    return { text: "", reason: "BodyText 섹션과 PrvText가 모두 없음" };
  }

  const parts: string[] = [];
  for (const path of sections) {
    const raw = readStream(container, path);
    if (!raw) continue;
    const inflated = decompressSection(raw, compressed);
    if (!inflated) continue;
    parts.push(readParaTexts(inflated));
  }

  const text = parts.join("\n").trim();
  if (text.length === 0) {
    return { text: "", reason: "본문 레코드에서 추출된 글자가 없음" };
  }
  return { text, reason: null };
}

/** 레코드 스트림을 훑어 HWPTAG_PARA_TEXT만 이어붙인다. */
function readParaTexts(stream: Buffer): string {
  let offset = 0;
  const chunks: string[] = [];
  while (offset + 4 <= stream.length) {
    const header = stream.readUInt32LE(offset);
    offset += 4;
    const tagId = header & 0x3ff;
    let size = (header >>> 20) & 0xfff;
    // size가 0xfff면 실제 길이가 뒤따르는 4바이트에 들어 있다 (확장 길이).
    if (size === 0xfff) {
      if (offset + 4 > stream.length) break;
      size = stream.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + size > stream.length) break;
    if (tagId === HWPTAG_PARA_TEXT) {
      chunks.push(decodeParaText(stream.subarray(offset, offset + size)));
    }
    offset += size;
  }
  return chunks.join("\n");
}
