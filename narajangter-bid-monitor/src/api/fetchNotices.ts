import { logger } from "../logger.js";
import { toApiDateTime } from "./dateUtil.js";
import type { FieldCandidates } from "./fieldCandidates.js";
import { fetchAllPages } from "./httpClient.js";
import { normalizeRawItem } from "./normalize.js";
import type { BusinessType, FetchResult, FetchWindow, NormalizedNotice, SourceType } from "./types.js";
import { toErrorMessage } from "../errors.js";

export interface FetchNoticesConfig {
  sourceLabel: string; // "본공고" | "사전규격" (로그용)
  sourceType: SourceType;
  baseUrl: string;
  serviceKey: string;
  operations: Record<BusinessType, string>;
  fieldCandidates: FieldCandidates;
  window: FetchWindow;
  numOfRows: number;
  maxPages: number;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  requestIntervalMs: number;
  /** 2페이지 이후를 동시에 받을 개수 (env.apiPageConcurrency) */
  pageConcurrency?: number;
}

/**
 * 물품/용역/공사 3개 업무구분을 각각 조회한다. 한 업무구분 조회가 실패해도 나머지는 계속 진행하며
 * (부분 실패 허용), 실패 여부는 FetchResult.failed 로 리포트에 반영된다.
 *
 * 세 업무구분은 서로 독립적이라 동시에 조회한다. 순차로 돌리면 본공고 3종에만 100초 가까이
 * 걸리는데, 그중 대부분이 남의 응답을 기다리는 시간이다. Promise.allSettled가 아니라
 * 각 작업 안에서 try/catch로 감싸는 이유는, 여기서 부분 실패를 FetchResult로 바꿔
 * 담아야 호출부가 기존과 똑같은 모양(순서 포함)을 받기 때문이다.
 */
export async function fetchNoticesBySourceType(config: FetchNoticesConfig): Promise<FetchResult[]> {
  const businessTypes = Object.keys(config.operations) as BusinessType[];

  return Promise.all(
    businessTypes.map(async (businessType): Promise<FetchResult> => {
      const operation = config.operations[businessType];
      const label = `${config.sourceLabel}/${businessType}`;

      try {
        const rawItems = await fetchAllPages(
          {
            baseUrl: config.baseUrl,
            operation,
            serviceKey: config.serviceKey,
            params: {
              inqryDiv: "1",
              inqryBgnDt: toApiDateTime(config.window.begin),
              inqryEndDt: toApiDateTime(config.window.end),
            },
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
            retryDelayMs: config.retryDelayMs,
            label,
          },
          {
            numOfRows: config.numOfRows,
            maxPages: config.maxPages,
            requestIntervalMs: config.requestIntervalMs,
            pageConcurrency: config.pageConcurrency,
          }
        );

        const notices = rawItems.map((raw) =>
          normalizeRawItem(raw, businessType, config.sourceType, config.fieldCandidates)
        );
        logger.info(`${label} 조회 완료`, { count: notices.length });
        return { businessType, notices, failed: false };
      } catch (err) {
        logger.error(`${label} 조회 실패`, { error: toErrorMessage(err) });
        return {
          businessType,
          notices: [],
          failed: true,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}

/** 공고 차수 (bidNtceOrd "000", "001" …). 없으면 0 */
function noticeOrd(n: NormalizedNotice): number {
  const v = Number(String(n.raw.bidNtceOrd ?? "").trim());
  return Number.isFinite(v) ? v : 0;
}

/** 나라장터가 취소한 공고. 취소하면 같은 공고번호로 차수를 올린 "취소공고"를 새로 게시한다. */
export function isCancelledNotice(n: NormalizedNotice): boolean {
  return /취소/.test(String(n.raw.ntceKindNm ?? ""));
}

/**
 * 공고번호 기준 중복 제거. 같은 번호가 여러 번 오면 **가장 높은 차수**(최신 상태)를 남기고,
 * 그게 취소공고면 아예 뺀다.
 *
 * 변경·취소 공고는 같은 공고번호에 차수만 올라가서 온다. 예전에는 먼저 받은 것을 남겨서
 * 000차 "등록공고"가 살아남고 001차 "취소공고"가 버려졌다 — 취소된 공고가 화면·알림에 계속
 * 떴다 (2026-09-29 건양대 건양회관 인테리어 공사 R26BK01744615, 최근 7일 취소공고 85건).
 */
export function dedupeNotices(results: FetchResult[]): FetchResult[] {
  return results.map((r) => {
    const latest = new Map<string, NormalizedNotice>();
    for (const n of r.notices) {
      const prev = latest.get(n.noticeNo);
      if (!prev || noticeOrd(n) >= noticeOrd(prev)) latest.set(n.noticeNo, n);
    }
    const notices = [...latest.values()];
    const live = notices.filter((n) => !isCancelledNotice(n));
    if (live.length < notices.length) {
      logger.info("취소된 공고 제외", { 구분: r.businessType, 제외: notices.length - live.length });
    }
    return { ...r, notices: live };
  });
}
