import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedNotice } from "../api/types.js";
import { classifyBidMethod } from "../matching/bidMethod.js";
import type { MatchedNotice } from "../matching/types.js";

/**
 * 보고 기록 — 매일·주간 텔레그램 보고에 실제로 나간 공고 목록 (2026-10-19, 4단계).
 *
 * 보고는 GitHub Actions(클라우드)에서 돌고 담당자 화면은 사무실 PC에서 돌아, 보고가 화면의 판단 기록에 직접 쓸 수 없다.
 * 그래서 보고가 이 기록을 파일로 남기면 워크플로가 저장소의 report-log 브랜치에 올리고, 화면 서버가 몇 분마다 받아
 * 판단 기록에 '미판단'으로 합친다 (scripts/ui.ts).
 *
 * 저장소가 공개라서 여기에는 나라장터에 공개된 공고 정보만 싣는다 — 담당자 이름·판단·사유는 절대 넣지 않는다.
 */
export type ReportKind = "daily" | "weekly";

/** 판단 기록의 meta와 같은 모양 (ui.html decisionMeta) — 판단 기록 CSV·키워드 조정용 집계가 그대로 쓴다 */
export interface ReportedMeta {
  sourceType: string;
  businessType: string;
  institution: string;
  budgetAmount: number | null;
  confidence: string;
  bidMethod: string | null;
  keywords: string[];
  products: string[];
  score: number | null;
  deadline: string | null;
  detailUrl: string | null;
}

export interface ReportedNotice {
  noticeNo: string;
  title: string;
  meta: ReportedMeta;
}

export interface ReportLogEntry {
  v: 1;
  kind: ReportKind;
  /** 보고한 날 (한국 날짜 YYYY-MM-DD) */
  date: string;
  reportedAt: string;
  notices: ReportedNotice[];
}

/** 한국 날짜 (YYYY-MM-DD) */
export function kstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 수요기관 — 나라장터 원본의 수요기관명, 없으면 null (공고기관과 다를 수 있다) */
export function demandInstitutionOf(n: NormalizedNotice): string | null {
  const raw = (n.raw ?? {}) as Record<string, unknown>;
  for (const key of ["dminsttNm", "rlDminsttNm", "dmndInsttNm"]) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function reportedNoticeOf(m: MatchedNotice): ReportedNotice {
  const n = m.notice;
  return {
    noticeNo: n.noticeNo,
    title: n.title,
    meta: {
      sourceType: n.sourceType,
      businessType: n.businessType,
      institution: demandInstitutionOf(n) ?? n.institution ?? "",
      budgetAmount: n.budgetAmount ?? null,
      confidence: m.confidence,
      bidMethod: classifyBidMethod(n.bidMethod),
      keywords: m.matchedKeywords,
      products: m.matchedProductCodes.map((c) => c.name),
      score: m.similarity ? Math.round(m.similarity.shown * 100) : null,
      deadline: n.deadline ?? null,
      detailUrl: n.detailUrl ?? null,
    },
  };
}

export function buildReportLog(kind: ReportKind, matches: MatchedNotice[], now: Date): ReportLogEntry {
  return { v: 1, kind, date: kstDate(now), reportedAt: now.toISOString(), notices: matches.map(reportedNoticeOf) };
}

/** 보고 기록 파일 이름 — 같은 날 같은 보고를 다시 보내면(FORCE_SEND) 같은 파일을 덮어쓴다 */
export const reportLogFileName = (entry: Pick<ReportLogEntry, "kind" | "date">): string => `${entry.date}-${entry.kind}.json`;

/** 워크플로가 report-log 브랜치에 올릴 파일을 쓴다 (output/report-log/). 쓴 경로를 돌려준다 */
export function writeReportLog(dir: string, entry: ReportLogEntry): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, reportLogFileName(entry));
  writeFileSync(path, JSON.stringify(entry, null, 2), "utf8");
  return path;
}

/** report-log 브랜치에서 읽은 파일 하나를 검사한다 — 모양이 다르면 null (다른 파일·손상된 파일은 건너뛴다) */
export function parseReportLog(text: string): ReportLogEntry | null {
  try {
    const e = JSON.parse(text) as Partial<ReportLogEntry>;
    if (e.v !== 1 || (e.kind !== "daily" && e.kind !== "weekly") || typeof e.date !== "string" || !Array.isArray(e.notices)) return null;
    const notices = e.notices.filter((n): n is ReportedNotice => typeof n?.noticeNo === "string" && n.noticeNo.trim() !== "" && typeof n.title === "string");
    return { v: 1, kind: e.kind, date: e.date, reportedAt: String(e.reportedAt ?? ""), notices };
  } catch {
    return null;
  }
}

/** 판단 기록 한 건 (scripts/ui.ts Participation 중 여기서 다루는 부분) */
export interface ReportedRecord {
  noticeNo: string;
  title: string;
  status: string | null;
  owner: string;
  updatedAt: string;
  comments: unknown[];
  meta?: Record<string, unknown>;
  /** 이 공고가 나간 보고 (보고일·종류). 있으면 판단 기록 탭에 판단 전이어도 '미판단'으로 보인다 */
  reports?: { date: string; kind: ReportKind }[];
}

/**
 * 보고 기록을 판단 기록에 합친다. 이미 있는 공고는 판단·담당·대화를 건드리지 않고 보고 표시만 더한다.
 * 같은 보고를 여러 번 합쳐도 결과가 같다. 바뀐 게 있으면 true (그때만 저장한다).
 */
export function mergeReportLog(records: Record<string, ReportedRecord>, entry: ReportLogEntry): boolean {
  let changed = false;
  for (const n of entry.notices) {
    const ref = { date: entry.date, kind: entry.kind };
    const p = records[n.noticeNo];
    if (!p) {
      records[n.noticeNo] = {
        noticeNo: n.noticeNo,
        title: n.title,
        status: null,
        owner: "",
        updatedAt: entry.reportedAt || new Date().toISOString(),
        comments: [],
        meta: { ...n.meta },
        reports: [ref],
      };
      changed = true;
      continue;
    }
    const reports = p.reports ?? [];
    if (!reports.some((r) => r.date === ref.date && r.kind === ref.kind)) {
      p.reports = [...reports, ref].sort((a, b) => a.date.localeCompare(b.date));
      changed = true;
    }
    if (!p.title && n.title) {
      p.title = n.title;
      changed = true;
    }
    // 판단할 때 남긴 공고 정보가 있으면 그대로 둔다 — 없을 때만 보고 때 정보로 채운다
    if (!p.meta || Object.keys(p.meta).length === 0) {
      p.meta = { ...n.meta };
      changed = true;
    }
  }
  return changed;
}

const DECISIONS = ["참가", "보류", "불참"];

/**
 * 판단 기록 탭에 보이는 상태. 참가·보류·불참이 아니면, 보고된 공고는 마감 전이면 '미판단', 마감이 지났으면 '놓침'.
 * 보고되지 않았고 판단도 없으면 null (판단 기록 탭에 싣지 않는다). 화면 ui.html logStatusOf와 같은 규칙.
 */
export function logStatusOf(p: Pick<ReportedRecord, "status" | "reports" | "meta">, now: Date): string | null {
  if (p.status && DECISIONS.includes(p.status)) return p.status;
  if (!p.reports?.length) return null;
  const deadline = typeof p.meta?.deadline === "string" ? kstDeadlineMs(p.meta.deadline) : null;
  return deadline !== null && deadline < now.getTime() ? "놓침" : "미판단";
}

/** "2026-10-24 10:00" 같은 한국 시각 → ms. 시각이 없으면 그날 23:59. 형식을 모르면 null (화면 deadlineAt과 같은 셈) */
function kstDeadlineMs(value: string): number | null {
  const m = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[ T]?(\d{2}):?(\d{2}))?/.exec(value.trim());
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, (m[4] === undefined ? 23 : +m[4]) - 9, m[5] === undefined ? 59 : +m[5]);
}
