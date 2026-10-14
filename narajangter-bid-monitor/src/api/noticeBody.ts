import { downloadDocuments, pickQuantityAttachments, pickSpecAttachments, type DownloadOptions, type NoticeAttachment } from "./attachments.js";
import { linkedPreStandardAttachments } from "./linkedPreStandard.js";
import { noticeOutline, quantityItems } from "./noticeOutline.js";
import { extractDocumentText } from "../corpus/extractText.js";
import { redactPersonal } from "../redactPersonal.js";
import type { NormalizedNotice } from "./types.js";
import { logger } from "../logger.js";
import { pickNoticeDocAttachments, preStandardAttachmentsResolved } from "../matching/qualificationDoc.js";
import { detectScopeFlags, type ScopeFlag } from "../matching/taskScopeFlags.js";

/**
 * 공고의 과업 내용을 첨부파일에서 읽어온다 (③.5 단계).
 *
 * 흐름: 응답의 첨부 목록 → 과업지시서류만 골라 → 다운로드 → 텍스트 추출 → 개인정보 마스킹.
 *
 * **항상 성공하지 않는다.** 실측상 매칭 공고의 약 1/4만 과업지시서류를 붙이고, 다운로드나
 * 추출이 실패할 수도 있다. 그래서 실패는 오류가 아니라 정상 경로다 — 본문이 없으면
 * 제목만으로 싱크로율을 매기는 기존 방식으로 돌아간다.
 */

export interface NoticeBody {
  text: string;
  /** 어느 첨부에서 뽑았는지 (추적용) */
  sourceFile: string;
  /** 가린 개인정보 요약 */
  redactions: Record<string, number>;
  /** 과업에 섞인 본업 밖 업무(유물 운송·대여·운영·홍보). 길이 상한으로 자르기 전 전체 본문에서 찾는다 */
  scopeFlags: ScopeFlag[];
  /**
   * 자르지 않은 문서 전체 (개인정보는 가린 것). 실적 키워드 점수는 이걸로 센다 — 뒤쪽 세부 과업 목록까지 봐야 해서다
   * (similarity/keywordScore.ts). text는 글자 비교용으로 앞 12,000자만 쓴다.
   */
  fullText: string;
}

export interface FetchBodyOptions extends DownloadOptions {
  /** 본문 길이 상한. 과업지시서 뒷부분의 일반조건은 모든 공고가 같아 변별력이 없다. */
  maxLength?: number;
  /** 스캔 PDF에 OCR을 쓸지. 기본 끔 — Windows 전용이고 쪽당 0.4~0.9초라 정기 실행에 부담이다. */
  ocr?: "off" | "auto";
}

/**
 * 본문 상한 12,000자 — 코퍼스 쪽(scanArchive.ts)과 같은 값을 쓴다.
 * 질의와 비교 대상이 같은 기준으로 잘려야 점수가 한쪽으로 치우치지 않는다.
 */
const DEFAULT_MAX_LENGTH = 12_000;

export async function fetchNoticeBody(
  notice: NormalizedNotice,
  options: FetchBodyOptions = {}
): Promise<NoticeBody | null> {
  // 사전규격은 첨부 파일명이 없고 URL만 온다 — 붙은 첨부가 곧 규격서·제안요청서라 순서대로 읽는다.
  // 군 기관 규격은 나라장터에 첨부가 없어 국방전자조달에서 찾는다.
  if (notice.sourceType === "사전규격") return readFirstDocument(await preStandardAttachmentsResolved(notice), options);
  // 본공고: 붙은 과업지시서·제안요청서·시방서 → 없거나 못 읽으면 연결된 사전규격의 규격서·제안요청서 (linkedPreStandard.ts)
  return (
    (await readFirstDocument(pickSpecAttachments(notice), options)) ??
    (await readFirstDocument(await linkedPreStandardAttachments(notice), options))
  );
}

/** 후보 첨부를 차례로 받아 글자가 나오는 첫 문서를 본문으로 쓴다. */
async function readFirstDocument(candidates: NoticeAttachment[], options: FetchBodyOptions): Promise<NoticeBody | null> {
  for (const attachment of candidates) {
    // ZIP이면 안에 든 문서를 과업지시서·제안요청서 순으로 하나씩 본다
    for (const doc of await downloadDocuments(attachment, options)) {
      // 묶음 안의 엑셀(내역서·품목표)은 과업 문서가 아니다 — 개요 대용으로만 쓴다 (fetchNoticeOutline)
      if (/\.xlsx$/i.test(doc.path)) continue;
      const extracted = await extractDocumentText(doc.path, { ocr: options.ocr ?? "off" });
      if (extracted.text.length === 0) {
        logger.debug?.("첨부 텍스트 추출 실패", { file: doc.name, reason: extracted.reason });
        continue;
      }

      // 공고 첨부에도 발주기관 담당자 성명·연락처가 그대로 들어 있다. 이 텍스트는 이후
      // ⑤ LLM 프롬프트로 나갈 수 있으므로 여기서 한 번 가린 뒤에 넘긴다.
      const masked = redactPersonal(extracted.text);

      return {
        text: masked.text.slice(0, options.maxLength ?? DEFAULT_MAX_LENGTH),
        fullText: masked.text,
        sourceFile: doc.name,
        redactions: masked.counts,
        scopeFlags: detectScopeFlags(masked.text),
      };
    }
  }

  return null;
}

export interface NoticeOutline {
  /** 공고문 개요 줄 + 내역서 공종·품명 (줄 단위) */
  text: string;
  /** 화면에 보일 출처 — "입찰공고문·공내역서" 등 */
  sourceFile: string;
}

/**
 * 과업지시서를 끝내 못 찾은 공고의 개요 대용 — 입찰공고문의 개요 줄과 공내역서의 공종·품명 (noticeOutline.ts).
 *
 * **싱크로율 점수에는 쓰지 않는다.** 2026-10-13 실측(제목만으로 매긴 25건): 이 글을 본문처럼 넣으면
 * 짧은 글이 과업지시서용 보정 곡선을 타서 내용이 그대로인데도 29%→38%처럼 숫자만 뛰었고,
 * "박물관 화장실 개선공사"(48%)가 "박물관 전시실 리모델링"(24%)보다 높게 나와 변별이 되지 않았다.
 * 대신 싱크로율 근거의 실적 키워드(진열장·전시구조물·그래픽 등)를 찾는 데 쓴다.
 */
export async function fetchNoticeOutline(notice: NormalizedNotice, options: DownloadOptions = {}): Promise<NoticeOutline | null> {
  const parts: string[] = [];
  const sources: string[] = [];
  for (const attachment of pickNoticeDocAttachments(notice).slice(0, 1)) {
    for (const doc of await downloadDocuments(attachment, options)) {
      const outline = noticeOutline((await extractDocumentText(doc.path)).text);
      if (outline) {
        parts.push(outline);
        sources.push("입찰공고문");
      }
      break;
    }
  }
  for (const attachment of pickQuantityAttachments(notice)) {
    for (const doc of await downloadDocuments(attachment, options)) {
      if (!/\.xlsx$/i.test(doc.path)) continue;
      const items = quantityItems((await extractDocumentText(doc.path)).text);
      if (items.length) {
        parts.push(items.join("\n"));
        if (!sources.includes("공내역서")) sources.push("공내역서");
      }
    }
  }
  return parts.length ? { text: redactPersonal(parts.join("\n")).text, sourceFile: sources.join("·") } : null;
}

/**
 * 여러 공고의 본문을 순차로 받아온다.
 *
 * 병렬로 쏘지 않는다 — 상대는 조달청 서버이고, 우리가 급할 이유가 없다. 기존 API 호출에도
 * 간격을 두고 있어서 같은 원칙을 지킨다. 30건 내외라 순차로도 몇 분이면 끝난다.
 */
export async function fetchNoticeBodies(
  notices: NormalizedNotice[],
  options: FetchBodyOptions & {
    intervalMs?: number;
    onProgress?: (done: number, total: number, notice: NormalizedNotice, body: NoticeBody | null) => void;
  } = {}
): Promise<Map<string, NoticeBody>> {
  const result = new Map<string, NoticeBody>();
  const interval = options.intervalMs ?? 300;

  for (const [index, notice] of notices.entries()) {
    let body: NoticeBody | null = null;
    try {
      body = await fetchNoticeBody(notice, options);
    } catch (err) {
      // 한 건이 실패해도 나머지는 계속한다 — 본문은 부가 정보다.
      logger.warn("공고 본문 수집 실패", { noticeNo: notice.noticeNo, error: String(err) });
    }
    if (body) result.set(notice.noticeNo, body);
    options.onProgress?.(index + 1, notices.length, notice, body);

    if (interval > 0 && index < notices.length - 1) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  return result;
}
