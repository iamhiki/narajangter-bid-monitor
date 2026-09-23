import { XMLParser } from "fast-xml-parser";
import { ApiError, ApiResultError } from "../errors.js";
import { logger } from "../logger.js";
import { RETRYABLE_RESULT_CODES, SUCCESS_RESULT_CODES, describeResultCode } from "./resultCodes.js";
import type { RawItem } from "./fieldResolver.js";

const xmlParser = new XMLParser({ ignoreAttributes: true, trimValues: true });

export interface ApiCallOptions {
  baseUrl: string;
  operation: string;
  serviceKey: string;
  params: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  /** 로그/에러 메시지에 표시할 사람이 읽을 수 있는 이름 */
  label: string;
}

export interface Envelope {
  resultCode: string;
  resultMsg: string;
  items: RawItem[];
  totalCount: number;
  pageNo: number;
  numOfRows: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * data.go.kr의 items 필드는 버전/오류상황에 따라 배열, 단일 객체, {item: [...]}, {item: {...}}, 빈 문자열 등
 * 여러 형태로 내려온다. 모두 정규화해서 RawItem[] 로 통일한다.
 */
function normalizeItems(itemsField: unknown): RawItem[] {
  if (itemsField === undefined || itemsField === null || itemsField === "") return [];

  if (Array.isArray(itemsField)) {
    return itemsField.filter((v): v is RawItem => typeof v === "object" && v !== null);
  }

  if (typeof itemsField === "object") {
    const obj = itemsField as Record<string, unknown>;
    if ("item" in obj) {
      return normalizeItems(obj.item);
    }
    return [obj];
  }

  return [];
}

/**
 * 응답 트리 어딘가에서 resultCode/resultMsg를 가진 객체를 재귀적으로 찾는다.
 * data.go.kr 표준 형식은 response.header 아래 있지만, 일부 오퍼레이션은
 * `{"nkoneps.com.response.ResponseError": {...}}` 같은 비표준 오류 포맷을 내려주기도 해서
 * 고정 경로(response.header)만 보면 실제 오류코드를 놓치고 기본값(99)으로 덮어써버린다.
 */
function findHeader(node: unknown, depth = 0): { resultCode: string; resultMsg: string } | null {
  if (depth > 5 || node === null || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  if ("resultCode" in obj) {
    return {
      resultCode: String(obj.resultCode ?? "").trim(),
      resultMsg: String(obj.resultMsg ?? "알 수 없는 응답 형식").trim(),
    };
  }

  for (const value of Object.values(obj)) {
    const found = findHeader(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractEnvelope(parsed: unknown): Envelope {
  const root = parsed as Record<string, unknown>;
  const response = (root?.response ?? root) as Record<string, unknown> | undefined;
  const body = (response?.body ?? {}) as Record<string, unknown>;

  const header = findHeader(root);
  const resultCode = header?.resultCode || "99";
  const resultMsg = header?.resultMsg ?? "알 수 없는 응답 형식";

  const items = normalizeItems(body.items);
  const totalCount = Number(body.totalCount ?? items.length) || 0;
  const pageNo = Number(body.pageNo ?? 1) || 1;
  const numOfRows = Number(body.numOfRows ?? items.length) || items.length;

  return { resultCode, resultMsg, items, totalCount, pageNo, numOfRows };
}

export function parseResponseBody(text: string, label: string): Envelope {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ApiError(label, "빈 응답을 받았습니다");
  }

  // data.go.kr은 type=json을 요청해도 인증 오류 등에서는 XML을 반환하는 경우가 있어 둘 다 시도한다.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return extractEnvelope(JSON.parse(trimmed));
    } catch (err) {
      throw new ApiError(label, `JSON 파싱 실패: ${err instanceof Error ? err.message : err}`, err);
    }
  }

  try {
    return extractEnvelope(xmlParser.parse(trimmed));
  } catch (err) {
    throw new ApiError(
      label,
      `응답을 JSON/XML 어느 쪽으로도 해석할 수 없습니다 (앞부분: ${trimmed.slice(0, 200)})`,
      err
    );
  }
}

async function callOnce(options: ApiCallOptions, extraParams: Record<string, string>): Promise<Envelope> {
  const url = new URL(`${options.baseUrl.replace(/\/+$/, "")}/${options.operation}`);
  url.searchParams.set("serviceKey", options.serviceKey);
  url.searchParams.set("type", "json");
  for (const [key, value] of Object.entries({ ...options.params, ...extraParams })) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();

    if (!res.ok) {
      throw new ApiError(options.label, `HTTP ${res.status} ${res.statusText} (응답 앞부분: ${text.slice(0, 200)})`);
    }

    const envelope = parseResponseBody(text, options.label);

    if (!SUCCESS_RESULT_CODES.has(envelope.resultCode)) {
      const description = describeResultCode(envelope.resultCode);
      const detail = envelope.resultMsg && envelope.resultMsg !== description ? ` (원본 메시지: ${envelope.resultMsg})` : "";
      throw new ApiResultError(options.label, envelope.resultCode, `${description}${detail}`);
    }

    return envelope;
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ApiResultError) return RETRYABLE_RESULT_CODES.has(err.resultCode);
  if (err instanceof ApiError) return true; // 네트워크/타임아웃/HTTP 5xx/파싱 실패는 재시도 대상
  if (err instanceof Error && err.name === "AbortError") return true;
  return true;
}

async function callWithRetry(options: ApiCallOptions, extraParams: Record<string, string>): Promise<Envelope> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await callOnce(options, extraParams);
    } catch (err) {
      lastError = err;
      const retryable = isRetryable(err);
      const isLastAttempt = attempt === options.maxRetries;
      logger.warn(`API 호출 실패 (${attempt + 1}/${options.maxRetries + 1}시도)`, {
        label: options.label,
        error: err instanceof Error ? err.message : String(err),
        retryable,
      });
      if (!retryable || isLastAttempt) break;
      const delay = options.retryDelayMs * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new ApiError(options.label, String(lastError));
}

/**
 * 작업들을 최대 concurrency개씩만 동시에 돌린다. 결과는 입력 순서를 유지한다.
 *
 * data.go.kr에는 TPS 제한이 있어 전부 한꺼번에 던지면 오히려 오류가 늘어난다.
 * 그래서 "전부 병렬"이 아니라 "정해진 개수만 병렬"이다.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * 페이지네이션을 모두 순회하며 전체 결과를 수집한다.
 * totalCount 및 안전장치(maxPages)로 무한루프를 방지한다.
 *
 * 1페이지를 먼저 받아 totalCount를 확인한 뒤, 나머지 페이지는 동시에 받는다.
 * 한 장씩 순차로 받으면 면허제한정보(8천여 건 = 18페이지)에만 70초 넘게 걸린다.
 * totalCount를 못 믿는 응답(0 또는 누락)일 때는 기존처럼 한 장씩 끝까지 따라간다.
 */
export async function fetchAllPages(
  options: ApiCallOptions,
  pageParams: {
    numOfRows: number;
    maxPages: number;
    requestIntervalMs: number;
    /** 2페이지 이후를 동시에 받을 개수. 1이면 기존과 같은 순차 동작. */
    pageConcurrency?: number;
  }
): Promise<RawItem[]> {
  const fetchPage = (pageNo: number) =>
    callWithRetry(options, {
      pageNo: String(pageNo),
      numOfRows: String(pageParams.numOfRows),
    });

  const firstPage = await fetchPage(1);
  const all: RawItem[] = [...firstPage.items];

  const firstPageWasLast =
    firstPage.items.length === 0 ||
    firstPage.items.length < pageParams.numOfRows ||
    all.length >= firstPage.totalCount;
  if (firstPageWasLast) return all;

  const concurrency = Math.max(1, pageParams.pageConcurrency ?? 1);
  const totalPagesByCount =
    firstPage.totalCount > 0 ? Math.ceil(firstPage.totalCount / pageParams.numOfRows) : 0;

  // totalCount를 신뢰할 수 있을 때만 남은 페이지를 한꺼번에 계획할 수 있다.
  if (totalPagesByCount > 1 && concurrency > 1) {
    const lastPage = Math.min(totalPagesByCount, pageParams.maxPages);
    const remaining = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);

    const pages = await mapWithConcurrency(remaining, concurrency, async (pageNo, index) => {
      // 동시 실행 묶음 안에서도 요청이 한 순간에 몰리지 않도록 살짝 흩뜨린다.
      if (pageParams.requestIntervalMs > 0 && index >= concurrency) {
        await sleep(pageParams.requestIntervalMs);
      }
      return fetchPage(pageNo);
    });

    for (const page of pages) all.push(...page.items);

    if (totalPagesByCount > pageParams.maxPages) {
      logger.warn(
        `최대 페이지 수(${pageParams.maxPages})에 도달해 조회를 중단했습니다. 일부 데이터가 누락될 수 있습니다.`,
        { label: options.label, collected: all.length, totalCount: firstPage.totalCount }
      );
    }
    return all;
  }

  // 순차 경로 (pageConcurrency=1 이거나 totalCount를 믿을 수 없는 경우)
  let pageNo = 2;
  while (pageNo <= pageParams.maxPages) {
    if (pageParams.requestIntervalMs > 0) await sleep(pageParams.requestIntervalMs);

    const envelope = await fetchPage(pageNo);
    all.push(...envelope.items);

    if (
      envelope.items.length === 0 ||
      envelope.items.length < pageParams.numOfRows ||
      all.length >= envelope.totalCount
    ) {
      return all;
    }
    pageNo += 1;
  }

  logger.warn(
    `최대 페이지 수(${pageParams.maxPages})에 도달해 조회를 중단했습니다. 일부 데이터가 누락될 수 있습니다.`,
    { label: options.label, collected: all.length }
  );
  return all;
}
