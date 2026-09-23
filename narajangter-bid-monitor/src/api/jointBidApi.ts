import type { NormalizedNotice } from "./types.js";
import { logger } from "../logger.js";

/**
 * 공동수급(공동이행/분담이행) 허용 여부 — g2b.go.kr 비공식 상세 API.
 *
 * data.go.kr 나라장터 OpenAPI(이 프로젝트가 쓰는 정식 API) 응답에는 "공동수급협정서 제출 및
 * 구성방식" 값이 **아예 없다.** 이 값은 g2b.go.kr 웹 화면(입찰공고 상세 팝업)이 별도로
 * 호출하는 자체 데이터 API에만 있다는 것을 실측으로 확인했다(2026-09-14, scripts/surveyJointBidG2B.ts
 * 참고). 아래 3건으로 교차 검증 완료:
 *   - R26BK01720867 → "(없음)공동수급불허"
 *   - R26BK01695832 → "(수기)공동이행 또는 분담이행"
 *   - R26BK01694102 → "(전자)분담이행"
 *
 * **정보 표시 전용이다.** 공동수급 가능 여부로 공고를 거르거나 등급(강력추천/참고용)을
 * 바꾸지 않는다 — "공동수급불허인데 지일 혼자 감당하기엔 큰 사업"처럼 판단이 필요한 부분은
 * 회사의 사업 판단이지 시스템이 객관적으로 결정할 수 있는 기준이 아니기 때문이다.
 *
 * **비공식 API라 항상 될 거라고 보장 못 한다.** 화면 구조가 바뀌면 언제든 깨질 수 있고,
 * 이 프로젝트가 쓰는 조달청 공식 OpenAPI와는 별개로 g2b.go.kr 자체가 막혀 있는 네트워크
 * (예: 일부 샌드박스 환경)에서는 호출이 안 된다. 그래서 실패해도 절대 파이프라인을 막지
 * 않고 그냥 "확인 안 됨"으로 남긴다 — 부가 정보이지 핵심 경로가 아니다.
 */

const G2B_HOME = "https://www.g2b.go.kr/";
const G2B_DETAIL_API = "https://www.g2b.go.kr/pn/pnp/pnpe/ItemBidPbac/selectItemAnncMngV.do";

/** data.go.kr raw 응답에 공고차수 필드가 있을 경우의 후보 키 (없으면 "000") */
const ORD_FIELD_CANDIDATES = ["bidNtceOrd", "ntceOrd", "bidPbancOrd"];

function decodeHtmlEntities(s: string): string {
  return s.replace(/&#40;/g, "(").replace(/&#41;/g, ")").replace(/&amp;/g, "&");
}

function guessOrd(raw: Record<string, unknown>): string {
  for (const key of ORD_FIELD_CANDIDATES) {
    const v = raw[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim().padStart(3, "0");
    if (typeof v === "number") return String(v).padStart(3, "0");
  }
  return "000";
}

export interface JointBidOptions {
  timeoutMs?: number;
  /** 여러 건 조회 시 요청 간 간격(ms). g2b.go.kr에 부담을 주지 않기 위함. */
  intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 300;

/** 세션 쿠키 확보. 실패해도 쿠키 없이 시도해본다 — 로그인 없이도 되는 것을 실측 확인했다. */
async function getSessionCookie(timeoutMs: number): Promise<string> {
  try {
    const res = await fetch(G2B_HOME, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return res.headers.get("set-cookie") ?? "";
  } catch {
    return "";
  }
}

/**
 * 공고 하나의 공동수급 방식을 조회한다. 실패하면(네트워크 차단, API 구조 변경, 조회 실패 등) null.
 *
 * 사전규격은 아직 정식 입찰공고가 아니라 이 상세 API 자체가 없으므로 호출부에서
 * 본공고(sourceType === "본공고")만 넘길 것.
 */
export async function fetchJointBidStatus(
  notice: NormalizedNotice,
  cookie: string,
  options: JointBidOptions = {}
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ord = guessOrd(notice.raw ?? {});

  try {
    const res = await fetch(G2B_DETAIL_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ dmItemMap: { bidPbancNo: notice.noticeNo, bidPbancOrd: ord } }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger.debug?.("공동수급 조회 실패 (HTTP)", { noticeNo: notice.noticeNo, status: res.status });
      return null;
    }

    const json = (await res.json()) as {
      ErrorMsg?: string;
      dmItemMap?: { jintCtrtCmnMthoNm?: string };
    };
    if (json.ErrorMsg && json.ErrorMsg !== "정상적으로 조회되었습니다.") {
      logger.debug?.("공동수급 조회 실패 (API)", { noticeNo: notice.noticeNo, reason: json.ErrorMsg });
      return null;
    }

    const raw = json.dmItemMap?.jintCtrtCmnMthoNm;
    return raw ? decodeHtmlEntities(raw) : null;
  } catch (err) {
    logger.debug?.("공동수급 조회 중 오류", { noticeNo: notice.noticeNo, error: String(err) });
    return null;
  }
}

/**
 * 여러 공고의 공동수급 방식을 순차로 조회한다 (부가 정보라 병렬로 밀어붙이지 않는다).
 *
 * 한 건이 실패해도 나머지는 계속 조회한다 — noticeBody.ts의 fetchNoticeBodies와 같은 원칙.
 */
export async function fetchJointBidStatuses(
  notices: NormalizedNotice[],
  options: JointBidOptions = {}
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (notices.length === 0) return result;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const cookie = await getSessionCookie(timeoutMs);

  for (const [index, notice] of notices.entries()) {
    const value = await fetchJointBidStatus(notice, cookie, options);
    if (value) result.set(notice.noticeNo, value);

    if (interval > 0 && index < notices.length - 1) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  return result;
}
