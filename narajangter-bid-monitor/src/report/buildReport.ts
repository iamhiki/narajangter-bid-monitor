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

/**
 * 나라장터 업종제한 미보유 — 빼지 않고 표시만 한다. 공동수급이 허용되면 함께 참가할 수 있어서
 * 공동수급 줄 바로 앞에 둔다.
 */
function missingQualificationText(m: MatchedNotice): string | undefined {
  const q = m.qualification;
  if (q?.status !== "미충족") return undefined;
  return `자격 미보유 (공동수급 확인 필요) — 아래 중 하나 필요: ${q.missing.map((g) => g.text ?? g.names.join(" 또는 ")).join(" / 또는 ")}`;
}

const QUAL_OK = "color:#15803d;";
const QUAL_MISS = "color:#b91c1c;font-weight:600;";
const QUAL_SPARE = "color:#9ca3af;";
const QUAL_OR = `<div style="color:#9ca3af;font-size:11px;padding:1px 0 1px 14px;">또는</div>`;

function qualItem(label: string, style: string, mark: string): string {
  return `<div style="${style}padding:1px 0;">${mark} ${escapeHtml(label)}</div>`;
}

function qualBlock(heading: string, items: string[], joiner = ""): string {
  return (
    `<div style="margin-top:8px;"><div style="font-size:12px;color:#6b7280;margin-bottom:2px;">${heading}</div>` +
    `${items.join(joiner)}</div>`
  );
}

/**
 * 자격 미보유 상세 — 카드 오른쪽 칸에 "필수 보유 / 이 중 하나" 묶음으로 한 줄씩 보여 준다.
 * 예전에는 "A + B + C 또는 D / 또는 …"를 본문 한 줄에 이어 붙여 무엇이 꼭 필요한지 읽기 어려웠다 (2026-10-19 요청).
 * 묶음 구조는 웹 화면 팝업(ui.html layoutHtml)과 같다. layout이 없는 예전 캐시는 참가 방법별 목록으로 보여 준다.
 */
function renderQualificationPanelHtml(m: MatchedNotice): string {
  const q = m.qualification;
  if (q?.status !== "미충족") return "";
  const parts: string[] = [];
  const layout = q.layout;
  if (layout && (layout.blocks.length > 0 || layout.methods)) {
    for (const b of layout.blocks) {
      if (b.kind === "all") {
        const h = b.options.length === 1 ? "필수 보유" : `필수 보유 — ${b.options.length}개 모두 필요`;
        parts.push(qualBlock(h, b.options.map((o) => (o.held ? qualItem(o.label, QUAL_OK, "✓") : qualItem(o.label, QUAL_MISS, "✗")))));
      } else {
        const items = b.options.map((o) =>
          o.held ? qualItem(o.label, QUAL_OK, "✓") : b.met ? qualItem(o.label, QUAL_SPARE, "–") : qualItem(o.label, QUAL_MISS, "✗")
        );
        parts.push(qualBlock(`아래 중 1개 이상 — ${b.met ? "보유로 충족" : "미보유"}`, items, QUAL_OR));
      }
    }
    if (layout.methods) {
      const ok = (method: { held: boolean }[][]) => method.every((row) => row.some((o) => o.held));
      const anyOk = layout.methods.some(ok);
      const items = layout.methods.map((method) => {
        const text = method.map((row) => row.map((o) => o.label).join(" 또는 ")).join(" + ");
        return ok(method) ? qualItem(text, QUAL_OK, "✓") : anyOk ? qualItem(text, QUAL_SPARE, "–") : qualItem(text, QUAL_MISS, "✗");
      });
      parts.push(qualBlock(`아래 방법 중 하나 — ${anyOk ? "보유로 충족" : "미보유"}`, items, QUAL_OR));
    }
  } else {
    const items = q.missing.map((g) => qualItem(g.text ?? g.names.join(" 또는 "), QUAL_MISS, "✗"));
    parts.push(qualBlock(q.missing.length > 1 ? "아래 중 하나 필요" : "필요한 자격", items, QUAL_OR));
  }
  // 공동수급 불허면 부족한 자격을 함께 채울 업체를 구할 수 없어 빨강, 허용·미확인이면 노랑
  const denied = m.jointBidStatus !== undefined && /불허/.test(m.jointBidStatus);
  const joint = !m.jointBidStatus ? "공동수급 여부는 원문 확인" : denied ? "공동수급 불허 — 참가 어려움" : "공동수급으로 참가 검토";
  return `
      <td style="width:360px;vertical-align:top;padding-left:16px;">
        <div style="background:${denied ? "#fef2f2" : "#fffbeb"};border:1px solid ${denied ? "#fecaca" : "#fde68a"};border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.5;color:#374151;">
          <div style="font-size:13px;font-weight:700;color:${denied ? "#b91c1c" : "#b45309"};">자격 미보유</div>
          <div style="color:#6b7280;">${joint}</div>
          ${parts.join("")}
          <div style="margin-top:8px;font-size:11px;color:#9ca3af;">✓ 보유 · ✗ 미보유 · – 없어도 됨</div>
        </div>
      </td>`;
}

function renderMissingQualificationText(m: MatchedNotice): string | undefined {
  const text = missingQualificationText(m);
  return text ? `  ${text}` : undefined;
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
    ...(m.matchedServiceClasses ?? []).map((c) => `분류:${c.name}(${c.code})`),
  ]
    .map(
      (b) =>
        `<span style="display:inline-block;margin:2px 4px 0 0;padding:2px 8px;border-radius:10px;background:#eef2ff;color:#3730a3;font-size:12px;">${escapeHtml(
          b
        )}</span>`
    )
    .join("");

  return `
  <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="vertical-align:top;">
    <div style="margin-bottom:8px;">
      <span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${style.bg};color:${style.fg};font-size:12px;font-weight:600;margin-right:6px;">${m.confidence}</span>
      ${renderOverseasVenueBadgeHtml(m)}
      ${renderSimilarityHtml(m)}
      <span style="font-size:13px;color:#6b7280;">[${n.businessType}]</span>
    </div>
    <div style="font-size:16px;font-weight:600;margin-bottom:10px;">${titleHtml}</div>
    <div style="font-size:13px;color:#374151;line-height:1.7;">
      기관: ${escapeHtml(formatDisplayValue(n.institution))}<br/>
      사업금액: ${escapeHtml(formatBudget(n.budgetAmount))}<br/>
      마감/일정: ${escapeHtml(formatDisplayValue(n.deadline))}<br/>
      공고번호: ${escapeHtml(n.noticeNo)}${n.bidMethod ? `<br/>낙찰방법: ${escapeHtml(n.bidMethod)}` : ""}${renderJointBidHtml(m)}
    </div>
    <div style="margin-top:10px;">${badges}</div>
    </td>${renderQualificationPanelHtml(m)}</tr></table>
  </div>`;
}

function renderMatchCardText(m: MatchedNotice): string {
  const n = m.notice;
  const badges = [
    ...m.matchedProductCodes.map((c) => `품목:${c.name}(${c.code})`),
    ...m.matchedIndustryCodes.map((c) => `업종:${c.name}(${c.code})`),
    ...m.matchedKeywords.map((k) => `키워드:${k}`),
    ...(m.matchedServiceClasses ?? []).map((c) => `분류:${c.name}(${c.code})`),
  ].join(", ");
  const overseasVenueTag = m.overseasVenueFlag
    ? ` [🌐 해외의심(몽골): 매칭 키워드=${m.overseasVenueFlag.matchedMongoliaKeyword}]`
    : "";
  return [
    `- [${m.confidence}][${n.businessType}]${overseasVenueTag} ${n.title}`,
    `  기관: ${formatDisplayValue(n.institution)} / 사업금액: ${formatBudget(n.budgetAmount)} / 마감: ${formatDisplayValue(n.deadline)}`,
    `  공고번호: ${n.noticeNo}${n.bidMethod ? ` / 낙찰방법: ${n.bidMethod}` : ""}`,
    `  매칭: ${badges}`,
    renderSimilarityText(m),
    renderMissingQualificationText(m),
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

/** title: 리포트 제목 (기본은 이메일 주간 리포트 제목). 텔레그램 정기 보고 첨부는 보고 이름을 넣는다. */
export function buildReport(input: ReportInput, options: { title?: string } = {}): ReportOutput {
  const title = options.title ?? "나라장터 입찰 모니터링 주간 리포트";
  const totalMatchCount = input.bid.matches.length + input.preStandard.matches.length;
  const hasFailures = input.bid.failures.length > 0 || input.preStandard.failures.length > 0;

  const dateLabel = formatDateForSubject(input.generatedAt);
  const subject = `[나라장터 입찰 모니터링] ${dateLabel} 주간 리포트 - 매칭 ${totalMatchCount}건${hasFailures ? " (일부 조회 실패)" : ""}`;

  const periodLabel = `${input.window.begin.toLocaleDateString("ko-KR")} ~ ${input.window.end.toLocaleDateString("ko-KR")}`;

  const html = `
  <div style="font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:960px;margin:0 auto;padding:0 16px;color:#111827;">
    <h1 style="font-size:20px;margin-bottom:4px;">${escapeHtml(title)}</h1>
    <div style="font-size:13px;color:#6b7280;margin-bottom:16px;">조회 기간: ${periodLabel} · 생성 시각: ${input.generatedAt.toLocaleString("ko-KR")}</div>
    ${renderSectionHtml("본공고", input.bid)}
    ${renderSectionHtml("사전규격", input.preStandard)}
    <div style="margin-top:24px;font-size:12px;color:#9ca3af;">
      본 리포트는 세부품명코드/업종코드/키워드 매칭 결과를 참고용으로 제공하며, 실제 입찰 참가 자격 및 요건은 반드시 원문 공고를 확인하시기 바랍니다.
    </div>
  </div>`;

  const text = [
    title,
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
