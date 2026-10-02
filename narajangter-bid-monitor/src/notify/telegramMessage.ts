import type { ReportInput, ReportSource } from "../report/buildReport.js";
import type { MatchedNotice } from "../matching/types.js";
import { sortMatches } from "../matching/matchEngine.js";
import { daysUntilDeadline } from "../matching/deadline.js";
import { formatBudget, formatDateForSubject, formatDisplayValue } from "../report/format.js";

/**
 * 텔레그램 sendMessage 한 건의 본문 상한은 4096자다. 텔레그램은 UTF-16 코드 단위로 세는데
 * 이는 JS String.length와 같은 단위라 별도 환산 없이 그대로 비교하면 된다.
 * HTML 태그까지 포함해 세므로 여유를 두고 3500자에서 끊는다.
 */
export const MAX_MESSAGE_CHARS = 3500;

/** 카드 한 장이 통째로 상한을 넘기지 않도록 가변 길이 필드에 거는 상한 */
const MAX_TITLE_CHARS = 200;
const MAX_BADGES_CHARS = 300;
const MAX_BID_METHOD_CHARS = 100;

/**
 * 텔레그램 HTML 파스 모드는 표준 HTML의 극히 일부만 허용하고(b/i/u/s/a/code/pre/blockquote 등),
 * 지원하는 문자 엔티티도 &lt; &gt; &amp; &quot; 네 가지뿐이다.
 * report/format.ts의 escapeHtml()은 작은따옴표를 &#39;로 바꾸는데 그건 지원 목록에 없어
 * 메시지에 그대로 노출되므로, 이메일용과 공유하지 않고 여기서 따로 이스케이프한다.
 */
export function escapeTelegramHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTelegramAttr(input: string): string {
  return escapeTelegramHtml(input).replace(/"/g, "&quot;");
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

/** "2026-10-01 18:00:00" 처럼 긴 마감 표기를 "10-01"까지만 줄인다 (참고용 목록의 밀도를 위해). */
function shortDeadline(deadline: string | null): string {
  const value = formatDisplayValue(deadline);
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[2]}-${match[3]}` : truncate(value, 12);
}

function titleLink(m: MatchedNotice): string {
  const n = m.notice;
  const title = escapeTelegramHtml(truncate(n.title, MAX_TITLE_CHARS));
  return n.detailUrl ? `<a href="${escapeTelegramAttr(n.detailUrl)}">${title}</a>` : `<b>${title}</b>`;
}

function matchReason(m: MatchedNotice): string {
  return [
    ...m.matchedProductCodes.map((c) => `품목 ${c.name}`),
    ...m.matchedIndustryCodes.map((c) => `업종 ${c.name}`),
    ...m.matchedKeywords.map((k) => `키워드 ${k}`),
    ...(m.matchedServiceClasses ?? []).map((c) => `분류 ${c.name}`),
  ].join(", ");
}

function overseasTag(m: MatchedNotice): string {
  return m.overseasVenueFlag
    ? ` 🌐<i>해외의심(몽골: ${escapeTelegramHtml(m.overseasVenueFlag.matchedMongoliaKeyword)})</i>`
    : "";
}

/** 사전규격의 마감은 입찰 마감이 아니라 규격 의견 등록 마감이다. */
function deadlineLabel(n: MatchedNotice["notice"]): string {
  return n.sourceType === "사전규격" ? "의견마감" : "마감";
}

/** 강력추천 항목 — 판단에 필요한 정보를 모두 담는다. */
function renderPriorityItem(m: MatchedNotice, index: number): string {
  const n = m.notice;
  const lines = [
    `<b>${index}.</b> ${titleLink(m)}${overseasTag(m)}`,
    escapeTelegramHtml(
      `${formatDisplayValue(n.institution)} · 추정 ${formatBudget(n.budgetAmount)} · ${deadlineLabel(n)} ${formatDisplayValue(n.deadline)}`
    ),
  ];
  if (n.bidMethod) {
    lines.push(escapeTelegramHtml(`낙찰방법 ${truncate(n.bidMethod, MAX_BID_METHOD_CHARS)}`));
  }
  const reason = matchReason(m);
  if (reason) lines.push(`🏷 ${escapeTelegramHtml(truncate(reason, MAX_BADGES_CHARS))}`);
  const sync = similarityLine(m);
  if (sync) lines.push(sync);
  const missing = missingQualificationLine(m);
  if (missing) lines.push(missing);
  const jointBid = jointBidLine(m);
  if (jointBid) lines.push(jointBid);
  lines.push(`<code>${escapeTelegramHtml(n.noticeNo)}</code>`);
  return lines.join("\n");
}

/**
 * ④ 싱크로율 한 줄. 과거 수행사업과 얼마나 겹치는지 + 무엇과 겹치는지.
 *
 * 코퍼스가 없으면 아예 줄을 만들지 않는다 — "0%"는 "안 비슷하다"로 읽히는데
 * 실제 뜻은 "비교할 자료가 없다"라서 전혀 다르다.
 */
export function similarityLine(m: MatchedNotice): string | null {
  if (!m.similarity) return null;
  const percent = Math.round(m.similarity.shown * 100);
  const best = m.similarity.top[0];
  const detail = best && best.score > 0.02 ? ` · ${truncate(`${best.year} ${best.name}`, 40)}` : "";
  return `🔗 싱크로율 ${percent}%${escapeTelegramHtml(detail)}`;
}

/**
 * 나라장터 업종제한 미보유 한 줄. 미보유 공고도 빼지 않는다 — 공동수급이 허용되면 함께 참가할 수 있어서
 * 바로 아래 공동수급 줄과 같이 보도록 표시만 한다.
 */
export function missingQualificationLine(m: MatchedNotice): string | null {
  const q = m.qualification;
  if (q?.status !== "미충족") return null;
  // 참가 방법끼리는 "또는" — 이 중 하나만 갖추면 된다
  const names = q.missing.map((g) => g.text ?? g.names.join(" 또는 ")).join(" / 또는 ");
  return `⚠ 자격 미보유 — 필요: ${escapeTelegramHtml(truncate(names, 80))}`;
}

/**
 * 공동수급 허용 여부 한 줄 — 표시 전용 부가 정보. g2b.go.kr 비공식 API 조회에 성공한
 * 강력추천 건에만 붙는다 (조회를 안 켰거나 실패하면 필드 자체가 없다).
 */
function jointBidLine(m: MatchedNotice): string | null {
  if (!m.jointBidStatus) return null;
  return `🤝 공동수급 ${escapeTelegramHtml(m.jointBidStatus)}`;
}

/**
 * 참고용 항목 — 한 건당 두 줄로 압축한다.
 * 보고서는 중요한 것부터 읽히게 하는 게 목적이라, 확인이 필요한 목록까지 같은 밀도로
 * 늘어놓으면 강력추천이 묻힌다. 세부 정보는 첨부 HTML에서 본다.
 */
function renderBriefItem(m: MatchedNotice, index: number): string {
  const n = m.notice;
  return [
    `<b>${index}.</b> ${titleLink(m)}${overseasTag(m)}`,
    escapeTelegramHtml(
      `${formatDisplayValue(n.institution)} · 추정 ${formatBudget(n.budgetAmount)} · ${n.sourceType === "사전규격" ? "의견 " : ""}~${shortDeadline(n.deadline)}`
    ),
  ].join("\n");
}

function collectFailures(input: ReportInput): string[] {
  const all = [...input.bid.failures, ...input.preStandard.failures];
  return all.map((f) => `${f.businessType}(${f.errorMessage ?? "알 수 없는 오류"})`);
}

/**
 * 블록들을 상한 이하의 메시지 여러 건으로 나눈다.
 * 블록 하나는 절대 쪼개지 않는다 — 중간에서 자르면 <a> 같은 태그가 열린 채로 끝나
 * 텔레그램이 파싱 오류(400)를 내기 때문이다. 가변 필드에 이미 상한을 걸어둬서
 * 블록 하나가 상한을 넘는 일은 사실상 없지만, 그래도 넘는다면 태그를 전부 벗겨
 * 평문으로 잘라 보낸다(깨진 메시지보다 평문이 낫다).
 */
export function packIntoMessages(blocks: string[], maxChars = MAX_MESSAGE_CHARS): string[] {
  const separator = "\n\n";
  const messages: string[] = [];
  let current = "";

  for (const rawBlock of blocks) {
    const block =
      rawBlock.length <= maxChars ? rawBlock : truncate(rawBlock.replace(/<[^>]*>/g, ""), maxChars);

    if (current === "") {
      current = block;
      continue;
    }
    if (current.length + separator.length + block.length <= maxChars) {
      current += separator + block;
    } else {
      messages.push(current);
      current = block;
    }
  }

  if (current !== "") messages.push(current);
  return messages;
}

export interface ReportTally {
  total: number;
  priority: number;
  brief: number;
  bid: number;
  preStandard: number;
}

export function tallyReport(input: ReportInput): ReportTally {
  const all = [...input.bid.matches, ...input.preStandard.matches];
  return {
    total: all.length,
    priority: all.filter((m) => m.confidence === "강력추천").length,
    brief: all.filter((m) => m.confidence !== "강력추천").length,
    bid: input.bid.matches.length,
    preStandard: input.preStandard.matches.length,
  };
}

/** 구역 하나(본공고 또는 사전규격). 안에서 강력추천은 자세히, 참고용은 두 줄로. 비어 있으면 아무것도 안 만든다. */
function renderSourceSection(title: string, note: string, matches: MatchedNotice[]): string[] {
  if (matches.length === 0) return [];
  const sorted = sortMatches(matches);
  const priority = sorted.filter((m) => m.confidence === "강력추천");
  const brief = sorted.filter((m) => m.confidence !== "강력추천");
  const blocks = [`<b>━━ ${title} ${matches.length}건 ━━</b>\n<i>${note}</i>`];
  if (priority.length > 0) {
    blocks.push(`🔴 <b>강력추천 ${priority.length}건</b> <i>— 품목·업종 코드와 키워드가 모두 맞음</i>`);
    blocks.push(...priority.map((m, i) => renderPriorityItem(m, i + 1)));
  }
  if (brief.length > 0) {
    blocks.push(`⚪ <b>참고용 ${brief.length}건</b> <i>— 한쪽만 맞음, 확인 필요</i>`);
    blocks.push(...brief.map((m, i) => renderBriefItem(m, i + 1)));
  }
  return blocks;
}

function renderSummaryBlock(input: ReportInput, tally: ReportTally, weekly = false): string {
  const period = `${formatDateForSubject(input.window.begin)} ~ ${formatDateForSubject(input.window.end)}`;
  const lines = [
    weekly ? `📋 <b>나라장터 주간 공고 보고</b>` : `📋 <b>나라장터 입찰 모니터링 보고서</b>`,
    escapeTelegramHtml(`${formatDateForSubject(input.generatedAt)} 기준 · 조회기간 ${period}`),
  ];
  if (weekly) {
    lines.push(escapeTelegramHtml("입찰(적격심사·최저가 등)은 매일 아침 마감 임박 보고로 따로 보냅니다."));
  }
  lines.push("");

  if (tally.total === 0) {
    lines.push("이번 조회 기간에 조건에 맞는 공고가 <b>없습니다.</b>");
  } else {
    lines.push(
      `조회 기간 동안 조건에 맞는 공고 <b>${tally.total}건</b>이 확인되었습니다.`,
      "",
      `🔴 강력추천 <b>${tally.priority}건</b>`,
      `⚪ 참고용 <b>${tally.brief}건</b>`,
      escapeTelegramHtml(`본공고 ${tally.bid}건 · 사전규격 ${tally.preStandard}건`)
    );
  }

  // 조회 실패 경고는 매칭 0건일 때가 오히려 더 중요하다 — 경고가 없으면 "올라온 공고가
  // 없구나"로 읽히지만, 실제로는 조회 자체가 깨져서 못 본 것일 수 있다.
  const failures = collectFailures(input);
  if (failures.length > 0) {
    lines.push("", `⚠️ <b>일부 조회 실패</b>: ${escapeTelegramHtml(truncate(failures.join(", "), 200))}`);
    lines.push(
      tally.total === 0
        ? "<i>조회가 실패한 구분에 공고가 있었을 수 있습니다. 0건이라고 단정하지 마세요.</i>"
        : "<i>아래 목록에 빠진 공고가 있을 수 있습니다.</i>"
    );
  }

  return lines.join("\n");
}

/** 매시간 확인에서 새로 나온 공고만 보낼 때의 머리말. 정기 보고서처럼 조회기간을 늘어놓지 않는다. */
/**
 * 웹 화면은 최근 7일 조건에 맞는 공고 전체를, 알림은 그중 새로 올라온 것만 보여준다. 개수가 달라
 * "빠진 게 있나" 헷갈리지 않게 머리말에 기간 전체 개수를 함께 적는다 (2026-09-29 담당자 요청).
 */
export interface WindowTotal {
  days: number;
  count: number;
}

function renderNewNoticesBlock(input: ReportInput, tally: ReportTally, windowTotal?: WindowTotal): string {
  const d = input.generatedAt;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const lines = [
    `🆕 <b>새 공고 ${tally.total}건</b>`,
    escapeTelegramHtml(`${formatDateForSubject(d)} ${time} 확인 · 본공고 ${tally.bid}건 · 사전규격 ${tally.preStandard}건`),
  ];
  if (windowTotal) {
    lines.push(
      escapeTelegramHtml(`최근 ${windowTotal.days}일 전체 ${windowTotal.count}건 중 새로 올라온 공고만 보냅니다 (전체 목록은 웹 화면)`)
    );
  }
  const failures = collectFailures(input);
  if (failures.length > 0) {
    lines.push("", `⚠️ <b>일부 조회 실패</b>: ${escapeTelegramHtml(truncate(failures.join(", "), 200))}`);
    lines.push("<i>빠진 공고는 다음 확인 때 다시 조회합니다.</i>");
  }
  return lines.join("\n");
}

export type TelegramMessageKind = "report" | "new" | "weekly";

/**
 * 리포트를 텔레그램 HTML 메시지 배열로 만든다 (4096자 상한 때문에 여러 건이 될 수 있다).
 *
 * kind "new"는 매시간 확인에서 새로 나온 공고만 보낼 때 쓴다 — 머리말과 끝맺음만 다르고
 * 공고 목록 모양은 같다. kind "weekly"는 주간 보고 머리말이다 (입찰은 매일 보고가 맡아 빠진 목록).
 */
export function buildTelegramMessages(
  input: ReportInput,
  options: { kind?: TelegramMessageKind; windowTotal?: WindowTotal } = {}
): string[] {
  const kind = options.kind ?? "report";
  const tally = tallyReport(input);
  const blocks: string[] = [
    kind === "new" ? renderNewNoticesBlock(input, tally, options.windowTotal) : renderSummaryBlock(input, tally, kind === "weekly"),
  ];

  // 본공고와 사전규격은 할 일이 다르다 — 본공고는 지금 입찰, 사전규격은 아직 규격 공개 단계(의견 등록만).
  // 섞어 두면 사전규격을 입찰로 착각하므로 구역을 나누고, 구역 안에서 강력추천 → 참고용 순으로 둔다.
  blocks.push(...renderSourceSection("📢 본공고", "지금 입찰할 수 있는 공고입니다.", input.bid.matches));
  blocks.push(
    ...renderSourceSection(
      "📝 사전규격",
      "입찰 전 규격 공개 단계입니다. 마감은 의견 등록 마감이고, 본공고가 올라오면 따로 알립니다.",
      input.preStandard.matches
    )
  );

  blocks.push(
    kind !== "report"
      ? "<i>※ 실제 참가 자격·요건은 원문 공고를 반드시 확인하세요.</i>"
      : tally.total > 0
        ? "<i>첨부된 HTML 파일에서 전체 내용을 확인하실 수 있습니다.\n※ 실제 참가 자격·요건은 원문 공고를 반드시 확인하세요.</i>"
        : "<i>※ 조건에 맞는 공고가 없어도 원문 공고를 직접 확인하실 수 있습니다.</i>"
  );

  return packIntoMessages(blocks);
}

/**
 * 매일 마감 임박 보고 (RUN_MODE=daily).
 *
 * 대상은 호출부가 골라 넘긴다 — 7일 안에 마감되는 "입찰"(적격심사·최저가 등) 본공고.
 * 새 공고 알림과 달리 **이미 알린 공고도 마감 전까지 매일 다시 보낸다.** 마감을 놓치지 않게
 * 하는 게 목적이라서다. 마감 빠른 순으로 늘어놓고 D-day를 맨 앞에 둔다.
 *
 * 0건이어도 한 줄은 보낸다 — 매일 오던 보고가 안 오면 "없어서"인지 "고장나서"인지 모른다.
 */
export function buildClosingSoonMessages(
  input: ReportInput,
  closingSoon: MatchedNotice[],
  options: { days: number }
): string[] {
  const d = input.generatedAt;
  const header = [
    `⏰ <b>마감 임박 입찰 ${closingSoon.length}건</b>`,
    escapeTelegramHtml(`${formatDateForSubject(d)} 기준 · ${options.days}일 안에 마감되는 입찰(적격심사·최저가 등) 본공고`),
  ];
  if (closingSoon.length === 0) header.push("", "오늘은 해당 공고가 <b>없습니다.</b>");

  const failures = collectFailures(input);
  if (failures.length > 0) {
    header.push("", `⚠️ <b>일부 조회 실패</b>: ${escapeTelegramHtml(truncate(failures.join(", "), 200))}`);
    header.push("<i>빠진 공고가 있을 수 있습니다.</i>");
  }

  const items = closingSoon.map((m, i) => {
    const n = m.notice;
    const left = daysUntilDeadline(n.deadline, d);
    const dday = left === null ? "" : left <= 0 ? "🔥<b>D-DAY</b> " : `<b>D-${left}</b> `;
    const lines = [
      `${dday}<b>${i + 1}.</b> ${titleLink(m)}`,
      escapeTelegramHtml(
        `${formatDisplayValue(n.institution)} · 추정 ${formatBudget(n.budgetAmount)} · 마감 ${formatDisplayValue(n.deadline)}`
      ),
    ];
    if (n.bidMethod) lines.push(escapeTelegramHtml(`낙찰방법 ${truncate(n.bidMethod, MAX_BID_METHOD_CHARS)}`));
    const reason = matchReason(m);
    if (reason) lines.push(`🏷 ${escapeTelegramHtml(truncate(reason, MAX_BADGES_CHARS))}`);
    const sync = similarityLine(m);
    if (sync) lines.push(sync);
    return lines.join("\n");
  });

  return packIntoMessages([
    header.join("\n"),
    ...items,
    "<i>※ 실제 참가 자격·요건은 원문 공고를 반드시 확인하세요.</i>",
  ]);
}

/** 첨부 HTML에 붙일 한 줄 설명 */
export function buildDocumentCaption(input: ReportInput): string {
  const tally = tallyReport(input);
  return `📄 ${formatDateForSubject(input.generatedAt)} 상세 보고서 (전체 ${tally.total}건 / 강력추천 ${tally.priority}건)`;
}

/** 첨부 파일명 — 날짜가 들어가야 대화방에 여러 개 쌓였을 때 구분된다. */
export function buildDocumentFilename(input: ReportInput): string {
  const d = input.generatedAt;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `입찰공고_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.html`;
}

/** 실행 실패 알림용 단문 메시지 */
export function buildTelegramFailureMessage(errorMessage: string, occurredAt: Date): string {
  return [
    "🚨 <b>나라장터 입찰 모니터링 실행 실패</b>",
    escapeTelegramHtml(occurredAt.toLocaleString("ko-KR")),
    "",
    `<pre>${escapeTelegramHtml(truncate(errorMessage, 2500))}</pre>`,
    "",
    escapeTelegramHtml("GitHub Actions 로그를 확인해주세요."),
  ].join("\n");
}

// 기존 이름으로 참조하는 곳이 있어 남겨둔다 (ReportSource는 섹션 단위 렌더링에 쓰였다).
export type { ReportSource };
