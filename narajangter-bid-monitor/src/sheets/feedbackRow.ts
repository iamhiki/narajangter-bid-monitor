import type { MatchedNotice } from "../matching/types.js";

/**
 * 피드백 시트의 열 구성.
 *
 * 앞쪽 16개는 시스템이 채우고, 뒤쪽 4개(판정/오판사유/판정자/판정일)는 담당자가 채운다.
 * 순서를 바꾸면 이미 쌓인 시트와 어긋나므로, 열을 추가할 때는 반드시 **끝에만** 덧붙일 것.
 * (예외적으로 싱크로율 3열은 시스템 구간 안쪽에 넣었다 — 그 시점에 담당자 판정이
 *  한 건도 입력돼 있지 않아 밀어도 짝이 갈라지지 않는 것을 시트에서 직접 확인했다.
 *  판정이 쌓인 뒤에는 이 방법을 쓸 수 없고 맨 끝에만 붙여야 한다.)
 *
 * "매칭근거" 열이 핵심이다 — 판정(O/X)만 남기면 나중에 "어느 규칙이 잘못 걸었는지"를
 * 되짚을 수 없어 규칙 개선에 쓸 수 없다. 어떤 키워드/코드가 이 공고를 걸어 올렸는지를
 * 판정과 같은 행에 붙여둬야 다음 사이클에서 그 규칙을 고칠 수 있다.
 */
export const FEEDBACK_HEADER = [
  "공고번호",
  "구분",
  "업무",
  "공고명",
  "발주기관",
  "예산(원)",
  "마감",
  "낙찰방법",
  "추천등급",
  "매칭근거",
  "해외의심",
  "링크",
  "수집일시",
  "싱크로율",
  "원점수",
  "싱크로율근거",
  "유사 과거사업",
  "공동수급방식",
  "판정",
  "오판사유",
  "판정자",
  "판정일",
] as const;

/**
 * 시스템이 채우는 열 개수 (이 뒤부터는 담당자 입력란이라 덮어쓰지 않는다).
 *
 * 13 → 16(싱크로율 3열) → 17(공동수급방식)로 늘었다. 담당자 판정 입력이 시트에
 * 하나도 없는 것을 2026-09-23에 직접 확인하고 늘렸다 — 이미 판정이 쌓인 뒤라면
 * 이 방법(시스템 구간 안쪽에 끼워 넣기) 대신 맨 끝에만 붙여야 한다(파일 상단 주석 참고).
 */
export const SYSTEM_COLUMN_COUNT = 18;

/** 담당자가 "판정" 열에 넣을 값 (시트 드롭다운으로 제한된다) */
export const VERDICT_OPTIONS = ["O (맞음)", "X (아님)", "보류"] as const;

export type FeedbackRow = (string | number)[];

function formatDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

/**
 * 시트에 값을 USER_ENTERED로 넣으면 =, +, -, @ 로 시작하는 문자열을 수식으로 해석한다.
 * 공고명은 조달청 API에서 그대로 받아온 외부 입력이라, 그런 제목이 하나 섞이면
 * 셀이 #NAME? 오류로 깨지거나 의도치 않은 수식이 실행된다. 앞에 작은따옴표를 붙여
 * 강제로 텍스트로 만든다(작은따옴표는 시트에 표시되지 않는다).
 */
export function sanitizeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * 시트에서 수식으로 해석되는 시작 문자 — `=` `+` `-` `@` 넷뿐이다.
 *
 * 이전 정규식 `/^[=+-@]/`는 `+-@`가 **문자 범위**(0x2B~0x40)로 읽혀서 의도한 4개가 아니라
 * **22개**를 잡았다 — 쉼표·마침표·슬래시·숫자 0~9·콜론 등이 전부 포함됐다. 그래서
 * `2026-09-30`(마감), `2026. 충북과학체험관`(공고명), `2023 평화테마파크`(유사 과거사업)처럼
 * 숫자로 시작하는 값에 전부 작은따옴표가 붙어 시트에서 강제 텍스트가 됐고, 마감 열은
 * 날짜 정렬·필터가 동작하지 않았다.
 *
 * 하이픈은 범위로 읽히지 않도록 맨 앞에 둔다.
 */
const FORMULA_START = /^[-=+@]/;

/** 어떤 규칙이 이 공고를 걸어 올렸는지를 사람이 읽을 수 있는 한 칸으로 만든다. */
export function formatMatchReason(m: MatchedNotice): string {
  const parts = [
    ...m.matchedProductCodes.map((c) => `품목 ${c.name}(${c.code})`),
    ...m.matchedIndustryCodes.map((c) => `업종 ${c.name}(${c.code})`),
    ...m.matchedKeywords.map((k) => `키워드 ${k}`),
  ];
  return parts.length > 0 ? parts.join(" / ") : "(근거 없음)";
}

/**
 * 유사 과거사업을 한 칸으로 만든다.
 *
 * 담당자가 "무엇과 비슷하다는 건가"를 바로 확인할 수 있어야 싱크로율 숫자를 믿거나
 * 의심할 수 있다 — 매칭근거 열이 있는 이유와 같다. 숫자만 남기면 3개월 뒤에
 * "이 0.5는 뭐였지"를 되짚을 수 없다.
 */
export function formatSimilarProjects(m: MatchedNotice): string {
  if (!m.similarity || m.similarity.top.length === 0) return "";
  return m.similarity.top
    .filter((t) => t.score > 0.02)
    .map((t) => `${t.year} ${t.name} (${t.score.toFixed(3)})`)
    .join(" / ");
}

export function toFeedbackRow(m: MatchedNotice, collectedAt: Date): FeedbackRow {
  const n = m.notice;
  return [
    sanitizeCell(n.noticeNo),
    n.sourceType,
    n.businessType,
    sanitizeCell(n.title),
    sanitizeCell(n.institution ?? ""),
    // 숫자로 넣어야 시트에서 정렬·필터·합계가 된다. 예산 미상은 빈 칸으로 둔다.
    n.budgetAmount ?? "",
    sanitizeCell(n.deadline ?? ""),
    sanitizeCell(n.bidMethod ?? ""),
    m.confidence,
    sanitizeCell(formatMatchReason(m)),
    m.overseasVenueFlag ? `몽골: ${m.overseasVenueFlag.matchedMongoliaKeyword}` : "",
    n.detailUrl ?? "",
    formatDateTime(collectedAt),
    // 숫자로 넣어야 시트에서 정렬·필터가 된다. 코퍼스가 없어 계산하지 못한 경우는
    // 0이 아니라 빈 칸이다 — 0은 "안 비슷하다", 빈 칸은 "비교할 자료가 없다"로 뜻이 다르다.
    // 사람이 읽는 값(보정). 0~100 정수 퍼센트로 넣어야 시트에서 바로 읽힌다.
    m.similarity ? Math.round(m.similarity.shown * 100) : "",
    // 원점수도 남긴다 — 보정 곡선을 고쳤을 때 과거 행을 다시 계산하려면 필요하다.
    m.similarity ? Number(m.similarity.score.toFixed(4)) : "",
    // 제목만 본 점수와 과업지시서까지 읽은 점수는 분포가 달라 직접 비교할 수 없다.
    // 임계값을 기준별로 나눠 보정하려면 이 값이 같은 행에 있어야 한다.
    m.similarity ? m.similarity.basis : "",
    sanitizeCell(formatSimilarProjects(m)),
    // 조회를 안 켰거나(withJointBidStatus 꺼짐) 비공식 API가 실패하면 빈 칸 — 표시 전용
    // 부가 정보라 "확인 안 됨"과 "공동수급불허"를 구분해야 한다(0 vs 빈 칸과 같은 이유).
    sanitizeCell(m.jointBidStatus ?? ""),
    // 판정/오판사유/판정자/판정일은 담당자 몫이라 빈 칸으로 남긴다.
  ];
}

/**
 * 이미 시트에 있는 공고번호를 빼고 새로 추가할 행만 만든다.
 *
 * 조회 기간(LOOKBACK_DAYS)이 실행 주기보다 길어서 같은 공고가 여러 번 수집되는데,
 * 그대로 추가하면 행이 중복될 뿐 아니라 담당자가 이미 판정해둔 행과 짝이 갈라진다.
 */
export function selectNewRows(
  matches: MatchedNotice[],
  existingNoticeNos: Iterable<string>,
  collectedAt: Date
): { rows: FeedbackRow[]; skipped: number } {
  const seen = new Set(existingNoticeNos);
  const rows: FeedbackRow[] = [];
  let skipped = 0;

  for (const m of matches) {
    const noticeNo = m.notice.noticeNo;
    if (seen.has(noticeNo)) {
      skipped += 1;
      continue;
    }
    // 같은 실행 안에서 본공고/사전규격에 같은 번호가 중복될 여지도 막는다.
    seen.add(noticeNo);
    rows.push(toFeedbackRow(m, collectedAt));
  }

  return { rows, skipped };
}
