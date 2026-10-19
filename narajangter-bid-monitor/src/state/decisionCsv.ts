/**
 * 판단 기록을 표(CSV)로 — 구글 드라이브 백업 폴더에 두어 팀원이 드라이브에서 표로 보게 한다 (2026-10-19 요청).
 * 열 구성은 화면 판단 기록 탭의 'CSV 내려받기'(ui.html downloadLogCsv)와 같다. 한쪽을 고치면 다른 쪽도 맞출 것.
 * 참가·보류·불참으로 판단한 공고만, 최근 판단 순으로 싣는다.
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
}

const DECISIONS = ["참가", "보류", "불참"];
const HEAD = ["판단일시", "판단", "주된 사유", "사유", "판단자", "담당", "공고번호", "공고명", "구분", "업무", "수요기관", "사업금액(원)", "추천등급", "낙찰방법", "관심 키워드", "등록 품목", "싱크로율(%)", "마감", "링크"];

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
export function decisionsCsv(records: Record<string, DecisionRecord>): string {
  const rows = Object.values(records)
    .filter((p) => p.status !== null && DECISIONS.includes(p.status))
    .sort((a, b) => String(b.decidedAt ?? "").localeCompare(String(a.decidedAt ?? "")))
    .map((p) => {
      const m = p.meta ?? {};
      return [
        kstDateTime(p.decidedAt), p.status, (p.tags ?? []).join(", "), p.reason ?? "", p.decidedBy ?? "", p.owner ?? "",
        p.noticeNo, p.title, m.sourceType, m.businessType, m.institution, m.budgetAmount, m.confidence, m.bidMethod,
        list(m.keywords), list(m.products), m.score, m.deadline, m.detailUrl,
      ];
    });
  return "﻿" + [HEAD, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
