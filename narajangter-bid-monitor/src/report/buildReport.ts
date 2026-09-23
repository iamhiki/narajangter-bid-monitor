import type { FetchResult } from "../api/types.js";
import type { MatchedNotice } from "../matching/types.js";
import { sortMatches } from "../matching/matchEngine.js";
import { HIGH_BAND, LOW_BAND } from "../similarity/calibrate.js";
import { escapeHtml, formatBudget, formatDateForSubject, formatDisplayValue } from "./format.js";

export interface ReportSource {
  matches: MatchedNotice[];
  failures: FetchResult[];
}

export interface ReportInput {
  generatedAt: Date;
  window: { begin: Date; end: Date };
  bid: ReportSource;
  preStandard: ReportSource;
}

export interface ReportOutput {
  subject: string;
  html: string;
  text: string;
  totalMatchCount: number;
  hasFailures: boolean;
}

const DEFAULT_CONFIDENCE_STYLE = { bg: "#e5e7eb", fg: "#374151" };
const CONFIDENCE_STYLE: Record<string, { bg: string; fg: string }> = {
  강력추천: { bg: "#fee2e2", fg: "#b91c1c" },
  참고용: DEFAULT_CONFIDENCE_STYLE,
};

function renderOverseasVenueBadgeHtml(m: MatchedNotice): string {
  if (!m.overseasVenueFlag) return "";
  const tooltip = escapeHtml(`몽골 관련 해외 개최 의심 (매칭 키워드: ${m.overseasVenueFlag.matchedMongoliaKeyword})`);
  return `<span title="${tooltip}" style="display:inline-block;padding:2px 8px;border-radius:10px;background:#ecfdf5;color:#047857;font-size:12px;font-weight:600;margin-right:6px;">🌐 해외의심(몽골)</span>`;
}

/**
 * ④ 싱크로율 배지 — 과거 수행사업과 얼마나 겹치는지.
 *
 * 숫자만 띄우면 담당자가 믿을 근거가 없으므로 가장 비슷한 과거사업 이름을 함께 적는다.
 * 코퍼스가 없는 환경에서는 필드 자체가 없고, 그때는 배지를 그리지 않는다 —
 * "0%"로 표시하면 "안 비슷하다"는 판단처럼 보이지만 실제로는 "비교할 자료가 없다"는 뜻이다.
 *
 * 기준선(0.35 / 0.20)은 아직 가설이라 색으로만 구분하고 걸러내지는 않는다.
 */
function renderSimilarityHtml(m: MatchedNotice): string {
  if (!m.similarity) return "";
  // 표시값(보정)을 쓴다. 원점수는 사람이 읽는 눈금이 아니다 — calibrate.ts 참고.
  const { shown, top } = m.similarity;
  const percent = Math.round(shown * 100);
  const tone =
    shown >= HIGH_BAND
      ? { bg: "#dcfce7", fg: "#14532d" }
      : shown >= LOW_BAND
        ? { bg: "#fef3c7", fg: "#78350f" }
        : { bg: "#f3f4f6", fg: "#4b5563" };
  const best = top[0];
  const detail = best && best.score > 0.02 ? ` · ${escapeHtml(`${best.year} ${best.name}`)}` : "";
  return (
    `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${tone.bg};` +
    `color:${tone.fg};font-size:12px;font-weight:600;margin-right:6px;">싱크로율 ${percent}%</span>` +
    `<span style="font-size:12px;color:#6b7280;">${detail}</span>`
  );
}

function renderSimilarityText(m: MatchedNotice): string | undefined {
  if (!m.similarity) return undefined;
  const best = m.similarity.top[0];
  const detail = best && best.score > 0.02 ? ` (유사: ${best.year} ${best.name})` : "";
  return `  싱크로율: ${Math.round(m.similarity.shown * 100)}%${detail}`;
}

/**
 * 공동수급 허용 여부 — 표시 전용 부가 정보. 조회를 안 켰거나(withJointBidStatus 꺼짐),
 * 비공식 API 호출이 실패했거나, 사전규격이라 대상이 아니면 필드 자체가 없으므로
 * 그때는 아무것도 그리지 않는다("확인 안 됨"을 "공동수급불허"로 오해하면 안 된다).
 */
function renderJointBidHtml(m: MatchedNotice): string {
  if (!m.jointBidStatus) return "";
  return `<br/>공동수급: ${escapeHtml(m.jointBidStatus)}`;
}

function renderJointBidText(m: MatchedNotice): string | undefined {
  if (!m.jointBidStatus) return undefined;
  return `  공동수급: ${m.jointBidStatus}`;
}

function renderMatchCardHtml(m: MatchedNotice): string {
  const n = m.notice;
  const style = CONFIDENCE_STYLE[m.confidence] ?? DEFAULT_CONFIDENCE_STYLE;
  const title = escapeHtml(n.title);
  const titleHtml = n.detailUrl
    ? `<a href="${escapeHtml(n.detailUrl)}" style="color:#1d4ed8;text-decoration:none;">${title}</a>`
    : title;

  const badges = [
    ...m.matchedProductCodes.map((c) => `품목:${c.name}(${c.code})`),
    ...m.matchedIndustryCodes.map((c) => `업종:${c.name}(${c.code})`),
    ...m.matchedKeywords.map((k) => `키워드:${k}`),
  ]
    .map(
      (b) =>
        `<span style="display:inline-block;margin:2px 4px 0 0;padding:2px 8px;border-radius:10px;background:#eef2ff;color:#3730a3;font-size:12px;">${escapeHtml(
          b
        )}</span>`
    )
    .join("");

  return `
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:10px;">
    <div style="margin-bottom:6px;">
      <span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${style.bg};color:${style.fg};font-size:12px;font-weight:600;margin-right:6px;">${m.confidence}</span>
      ${renderOverseasVenueBadgeHtml(m)}
      ${renderSimilarityHtml(m)}
      <span style="font-size:13px;color:#6b7280;">[${n.businessType}]</span>
    </div>
    <div style="font-size:15px;font-weight:600;margin-bottom:6px;">${titleHtml}</div>
    <div style="font-size:13px;color:#374151;line-height:1.6;">
      기관: ${escapeHtml(formatDisplayValue(n.institution))}<br/>
      예산: ${escapeHtml(formatBudget(n.budgetAmount))}<br/>
      마감/일정: ${escapeHtml(formatDisplayValue(n.deadline))}<br/>
      공고번호: ${escapeHtml(n.noticeNo)}${n.bidMethod ? `<br/>낙찰방법: ${escapeHtml(n.bidMethod)}` : ""}${renderJointBidHtml(m)}
    </div>
    <div style="margin-top:8px;">${badges}</div>
  </div>`;
}

function renderMatchCardText(m: MatchedNotice): string {
  const n = m.notice;
  const badges = [
    ...m.matchedProductCodes.map((c) => `품목:${c.name}(${c.code})`),
    ...m.matchedIndustryCodes.map((c) => `업종:${c.name}(${c.code})`),
    ...m.matchedKeywords.map((k) => `키워드:${k}`),
  ].join(", ");
  const overseasVenueTag = m.overseasVenueFlag
    ? ` [🌐 해외의심(몽골): 매칭 키워드=${m.overseasVenueFlag.matchedMongoliaKeyword}]`
    : "";
  return [
    `- [${m.confidence}][${n.businessType}]${overseasVenueTag} ${n.title}`,
    `  기관: ${formatDisplayValue(n.institution)} / 예산: ${formatBudget(n.budgetAmount)} / 마감: ${formatDisplayValue(n.deadline)}`,
    `  공고번호: ${n.noticeNo}${n.bidMethod ? ` / 낙찰방법: ${n.bidMethod}` : ""}`,
    `  매칭: ${badges}`,
    renderSimilarityText(m),
    renderJointBidText(m),
    n.detailUrl ? `  링크: ${n.detailUrl}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderSectionHtml(sectionTitle: string, source: ReportSource): string {
  const sorted = sortMatches(source.matches);
  const failureNotice =
    source.failures.length > 0
      ? `<div style="margin-bottom:10px;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;color:#9a3412;font-size:13px;">
          ⚠ 일부 조회 실패: ${source.failures
            .map((f) => `${f.businessType}(${escapeHtml(f.errorMessage ?? "알 수 없는 오류")})`)
            .join(", ")}
        </div>`
      : "";

  const body =
    sorted.length > 0
      ? sorted.map(renderMatchCardHtml).join("\n")
      : `<div style="color:#6b7280;font-size:13px;padding:8px 0;">이번 주 매칭된 공고가 없습니다.</div>`;

  return `
  <h2 style="font-size:17px;border-bottom:2px solid #111827;padding-bottom:6px;margin:24px 0 12px;">${sectionTitle} (${sorted.length}건)</h2>
  ${failureNotice}
  ${body}`;
}

function renderSectionText(sectionTitle: string, source: ReportSource): string {
  const sorted = sortMatches(source.matches);
  const lines = [`## ${sectionTitle} (${sorted.length}건)`];
  if (source.failures.length > 0) {
    lines.push(
      `[경고] 일부 조회 실패: ${source.failures.map((f) => `${f.businessType}(${f.errorMessage ?? "알 수 없는 오류"})`).join(", ")}`
    );
  }
  if (sorted.length === 0) {
    lines.push("이번 주 매칭된 공고가 없습니다.");
  } else {
    lines.push(...sorted.map(renderMatchCardText));
  }
  return lines.join("\n\n");
}

export function buildReport(input: ReportInput): ReportOutput {
  const totalMatchCount = input.bid.matches.length + input.preStandard.matches.length;
  const hasFailures = input.bid.failures.length > 0 || input.preStandard.failures.length > 0;

  const dateLabel = formatDateForSubject(input.generatedAt);
  const subject = `[나라장터 입찰 모니터링] ${dateLabel} 주간 리포트 - 매칭 ${totalMatchCount}건${hasFailures ? " (일부 조회 실패)" : ""}`;

  const periodLabel = `${input.window.begin.toLocaleDateString("ko-KR")} ~ ${input.window.end.toLocaleDateString("ko-KR")}`;

  const html = `
  <div style="font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:680px;margin:0 auto;color:#111827;">
    <h1 style="font-size:20px;margin-bottom:4px;">나라장터 입찰 모니터링 주간 리포트</h1>
    <div style="font-size:13px;color:#6b7280;margin-bottom:16px;">조회 기간: ${periodLabel} · 생성 시각: ${input.generatedAt.toLocaleString("ko-KR")}</div>
    ${renderSectionHtml("본공고", input.bid)}
    ${renderSectionHtml("사전규격", input.preStandard)}
    <div style="margin-top:24px;font-size:12px;color:#9ca3af;">
      본 리포트는 세부품명코드/업종코드/키워드 매칭 결과를 참고용으로 제공하며, 실제 입찰 참가 자격 및 요건은 반드시 원문 공고를 확인하시기 바랍니다.
    </div>
  </div>`;

  const text = [
    `나라장터 입찰 모니터링 주간 리포트`,
    `조회 기간: ${periodLabel} / 생성 시각: ${input.generatedAt.toLocaleString("ko-KR")}`,
    "",
    renderSectionText("본공고", input.bid),
    "",
    renderSectionText("사전규격", input.preStandard),
    "",
    "※ 매칭 결과는 참고용이며, 실제 참가 자격/요건은 원문 공고를 반드시 확인하세요.",
  ].join("\n");

  return { subject, html, text, totalMatchCount, hasFailures };
}
