import { logStatusOf, type ReportKind } from "./reportLog.js";

/**
 * 판단 기록을 표(CSV)로 — 구글 드라이브 백업 폴더에 두어 팀원이 드라이브에서 표로 보게 한다 (2026-10-19 요청).
 * 열 구성은 화면 판단 기록 탭의 'CSV 내려받기'(ui.html downloadLogCsv)와 같다. 한쪽을 고치면 다른 쪽도 맞출 것.
 * 판단 기록 탭과 같은 공고를 싣는다 — 참가·보류·불참으로 판단한 공고와, 보고됐지만 아직 판단하지 않은 공고(미판단·놓침).
 * 최근 순 (판단한 공고는 판단 시각, 판단 전 공고는 마지막 보고일).
 */
export interface DecisionRecord {
  noticeNo: string;
  title: string;
  status: string | null;
  owner: string;
  tags?: string[];
  reason?: string;
  decidedBy?: string;
  decidedAt?: string | null;
  meta?: Record<string, unknown>;
  reports?: { date: string; kind: ReportKind }[];
}

const HEAD = ["판단일시", "판단", "주된 사유", "사유", "판단자", "담당", "공고번호", "공고명", "구분", "업무", "수요기관", "사업금액(원)", "추천등급", "낙찰방법", "관심 키워드", "등록 품목", "싱크로율(%)", "마감", "링크", "보고일", "보고"];
const KIND_LABEL: Record<ReportKind, string> = { daily: "매일", weekly: "주간" };

/** 한국 시각 "YYYY-MM-DD HH:mm" — 화면 fmtDT와 같은 모양 (서버가 어느 시간대에서 돌든 한국 시각) */
function kstDateTime(iso: string | null | undefined): string {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return "";
  return new Date(t.getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

const cell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const list = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : "");

/** 엑셀·구글 시트에서 한글이 깨지지 않게 BOM을 붙인다 */
export function decisionsCsv(records: Record<string, DecisionRecord>, now = new Date()): string {
  const shown = Object.values(records)
    .map((p) => ({ p, status: logStatusOf(p, now) }))
    .filter((x): x is { p: DecisionRecord; status: string } => x.status !== null);
  const sortKey = ({ p, status }: { p: DecisionRecord; status: string }) =>
    status === "미판단" || status === "놓침" ? (p.reports?.at(-1)?.date ?? "") : String(p.decidedAt ?? "");
  const rows = shown
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
    .map(({ p, status }) => {
      const m = p.meta ?? {};
      const decided = status !== "미판단" && status !== "놓침";
      return [
        decided ? kstDateTime(p.decidedAt) : "", status, decided ? (p.tags ?? []).join(", ") : "", decided ? p.reason ?? "" : "",
        decided ? p.decidedBy ?? "" : "", p.owner ?? "",
        p.noticeNo, p.title, m.sourceType, m.businessType, m.institution, m.budgetAmount, m.confidence, m.bidMethod,
        list(m.keywords), list(m.products), m.score, m.deadline, m.detailUrl,
        [...new Set((p.reports ?? []).map((r) => r.date))].join(", "), [...new Set((p.reports ?? []).map((r) => KIND_LABEL[r.kind]))].join(", "),
      ];
    });
  return "\ufeff" + [HEAD, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
