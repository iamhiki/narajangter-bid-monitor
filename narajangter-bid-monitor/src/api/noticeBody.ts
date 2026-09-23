import { downloadAttachment, pickSpecAttachments, type DownloadOptions } from "./attachments.js";
import { extractDocumentText } from "../corpus/extractText.js";
import { redactPersonal } from "../redactPersonal.js";
import type { NormalizedNotice } from "./types.js";
import { logger } from "../logger.js";

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
  const candidates = pickSpecAttachments(notice);
  if (candidates.length === 0) return null;

  for (const attachment of candidates) {
    const path = await downloadAttachment(attachment, options);
    if (!path) continue;

    const extracted = await extractDocumentText(path, { ocr: options.ocr ?? "off" });
    if (extracted.text.length === 0) {
      logger.debug?.("첨부 텍스트 추출 실패", { file: attachment.name, reason: extracted.reason });
      continue;
    }

    // 공고 첨부에도 발주기관 담당자 성명·연락처가 그대로 들어 있다. 이 텍스트는 이후
    // ⑤ LLM 프롬프트로 나갈 수 있으므로 여기서 한 번 가린 뒤에 넘긴다.
    const masked = redactPersonal(extracted.text);

    return {
      text: masked.text.slice(0, options.maxLength ?? DEFAULT_MAX_LENGTH),
      sourceFile: attachment.name,
      redactions: masked.counts,
    };
  }

  return null;
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
