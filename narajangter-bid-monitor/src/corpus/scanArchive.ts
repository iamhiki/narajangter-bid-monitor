import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  extractBudgetAmount,
  extractDocumentText,
  extractOfficialName,
  type OcrMode,
} from "./extractText.js";
import type { OcrOptions } from "./ocr.js";
import type { PastProject } from "./types.js";

/**
 * 과거 공고 아카이브 폴더를 훑어 PastProject[]를 만든다.
 *
 * 기대 구조 (담당자가 이미 이렇게 정리해 둠):
 *   <아카이브>/<연도>/<사업 폴더>/<YYYYMMDD>_<문서명>_v1.<확장자>
 *
 * 사업 폴더 하나가 코퍼스 1행이다. 과업지시서가 없어도 행은 만든다 — 폴더명이 곧 사업명이라
 * 그것만으로도 유사도 비교가 된다. (전체 103개 중 30개가 과업지시서 유실 상태)
 */

/**
 * 본문으로 쓸 문서. 앞쪽이 우선순위가 높다.
 *
 * 패턴은 아래 normalizeFileName()으로 구분자를 공백으로 바꾼 이름에 대고 맞춘다.
 * 실제 아카이브에 `20250411_★_과업_지시서(정남진...).hwpx`처럼 낱말 사이에 밑줄이 낀
 * 파일이 있어서, 공백만 허용하면 그 사업 1건이 통째로 본문 없이 남는다.
 */
const SPEC_DOC_PATTERNS: RegExp[] = [/과업\s*지시/, /제안\s*요청|요청서/, /과업\s*내용/];

/** 밑줄·하이픈·점 등 파일명 구분자를 공백으로 바꿔 낱말 경계를 복원한다. */
export function normalizeFileName(name: string): string {
  return name.replace(/[_\-.·ㆍ★☆]+/g, " ").replace(/\s+/g, " ");
}

/** 본문으로 쓰면 안 되는 문서 — 회사 증명서·등급확인서라 사업 내용이 전혀 없다. */
const EXCLUDED_DOC = /수행능력|등급확인서|입찰등록서류|사업자등록|재무제표|청렴|위임장/;

/**
 * PDF도 후보에 넣되 **hwp/hwpx보다 뒤**로 민다 (pickSpecDocuments의 정렬 참고).
 * 아카이브 실측상 과업지시서 PDF 8개는 전부 같은 폴더에 hwp/hwpx 원본이 있는 인쇄본이라,
 * 굳이 느린 PDF 경로를 탈 이유가 없다. PDF만 있는 폴더에서만 PDF가 선택된다.
 */
const SUPPORTED_EXT = /\.(hwp|hwpx|pdf)$/i;
const PDF_EXT = /\.pdf$/i;

export interface ScanOptions {
  /** 본문 길이 상한. 과업지시서는 수만 자까지 가므로 앞부분만 쓴다 (아래 주석 참고). */
  maxBodyLength?: number;
  /** PDF를 만났을 때 OCR 사용 여부. 기본 "off". */
  ocr?: OcrMode;
  ocrOptions?: OcrOptions;
  onProgress?: (done: number, total: number, name: string) => void;
}

export interface ScanReport {
  projects: PastProject[];
  /** 본문 추출에 실패했거나 대상 문서가 없던 사업들 (원인 추적용) */
  withoutBody: { id: string; reason: string }[];
}

/**
 * 본문 기본 상한 12,000자.
 *
 * 과업지시서 뒷부분은 대금지급·하자보수·산업안전·비밀유지 같은 **모든 공고에 똑같이 들어가는
 * 일반조건**이다. 전부 넣으면 서로 다른 사업끼리 이 공통 문구 때문에 유사도가 일제히 올라가
 * 변별력이 죽는다. 사업 고유 정보(과업개요·추진배경·범위·전시물 구성)는 앞쪽에 몰려 있다.
 */
const DEFAULT_MAX_BODY = 12_000;

export async function scanArchive(archiveRoot: string, options: ScanOptions = {}): Promise<ScanReport> {
  const maxBodyLength = options.maxBodyLength ?? DEFAULT_MAX_BODY;
  const folders = listProjectFolders(archiveRoot);

  const projects: PastProject[] = [];
  const withoutBody: { id: string; reason: string }[] = [];

  for (const [index, folder] of folders.entries()) {
    const id = relative(archiveRoot, folder.path).replace(/\\/g, "/");
    options.onProgress?.(index + 1, folders.length, folder.name);

    const docs = pickSpecDocuments(folder.path);
    let body = "";
    const sourceFiles: string[] = [];
    const reasons: string[] = [];

    for (const doc of docs) {
      const result = await extractDocumentText(doc, { ocr: options.ocr, ocrOptions: options.ocrOptions });
      if (result.text.length > 0) {
        body = result.text;
        sourceFiles.push(relative(archiveRoot, doc).replace(/\\/g, "/"));
        break; // 우선순위가 가장 높은 문서 하나면 충분하다.
      }
      reasons.push(`${relative(folder.path, doc)}: ${result.reason ?? "빈 텍스트"}`);
    }

    if (body.length === 0) {
      withoutBody.push({ id, reason: docs.length === 0 ? "과업지시서/제안요청서 없음" : reasons.join(" | ") });
    }

    const officialName = body.length > 0 ? extractOfficialName(body) : null;

    projects.push({
      id,
      year: folder.year,
      folderName: folder.name,
      name: officialName ?? cleanFolderName(folder.name),
      officialName,
      body: body.slice(0, maxBodyLength),
      budgetAmount: body.length > 0 ? extractBudgetAmount(body) : null,
      sourceFiles,
    });
  }

  return { projects, withoutBody };
}

interface ProjectFolder {
  path: string;
  name: string;
  year: number;
}

function listProjectFolders(archiveRoot: string): ProjectFolder[] {
  const result: ProjectFolder[] = [];
  for (const yearEntry of safeReaddir(archiveRoot)) {
    const yearPath = join(archiveRoot, yearEntry);
    if (!isDirectory(yearPath)) continue;
    const year = Number(yearEntry);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) continue;

    for (const projectEntry of safeReaddir(yearPath)) {
      const projectPath = join(yearPath, projectEntry);
      if (!isDirectory(projectPath)) continue;
      result.push({ path: projectPath, name: projectEntry, year });
    }
  }
  return result;
}

/**
 * 폴더 안에서 본문으로 쓸 문서를 우선순위대로 고른다.
 * 같은 문서의 개정본이 여러 개 있으면(파일명 앞 날짜가 다름) 최신 날짜를 쓴다 —
 * "(수정)", "최종" 같은 표기는 일관되지 않아 파일명 날짜가 가장 믿을 만하다.
 */
export function pickSpecDocuments(folderPath: string): string[] {
  const candidates = safeReaddir(folderPath)
    .filter((name) => SUPPORTED_EXT.test(name) && !EXCLUDED_DOC.test(normalizeFileName(name)))
    .map((name) => ({ name, normalized: normalizeFileName(name), path: join(folderPath, name) }))
    .filter((f) => isFile(f.path));

  const ranked: { path: string; rank: number; isPdf: boolean; date: string }[] = [];
  for (const file of candidates) {
    const rank = SPEC_DOC_PATTERNS.findIndex((pattern) => pattern.test(file.normalized));
    if (rank < 0) continue;
    ranked.push({
      path: file.path,
      rank,
      isPdf: PDF_EXT.test(file.name),
      date: /^(\d{8})/.exec(file.name)?.[1] ?? "",
    });
  }

  // 문서 종류(과업지시서 > 제안요청서) → 형식(hwp/hwpx 먼저) → 최신 날짜 순.
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.isPdf !== b.isPdf) return a.isPdf ? 1 : -1;
    return b.date.localeCompare(a.date);
  });
  return ranked.map((r) => r.path);
}

/**
 * 폴더명을 사업명으로 정제한다: "2024_무안군_남악_중앙공원_복합놀이시설(물놀이장)_디자인_및_제작_설치"
 * → "무안군 남악 중앙공원 복합놀이시설(물놀이장) 디자인 및 제작 설치"
 *
 * 앞의 연도는 사업명이 아니라 분류용이라 뗀다. 남겨두면 같은 해 사업끼리
 * 연도 숫자 때문에 유사도가 올라간다.
 */
export function cleanFolderName(folderName: string): string {
  return folderName
    .replace(/^\d{4}[\s_-]*/, "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
