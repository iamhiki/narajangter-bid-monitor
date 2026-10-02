import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReportInput } from "../report/buildReport.js";
import { logger } from "../logger.js";

/**
 * 수집 결과를 디스크에 저장해 두고 즉시 다시 꺼내 쓰기 위한 캐시.
 *
 * 조회 한 번에 나라장터에서 1만여 건을 받아오느라 40초가 걸린다. 대화형으로 쓸 때
 * 명령마다 그만큼 기다릴 수는 없으므로, 수집(느림)과 조회(즉시)를 분리한다.
 * 봇이 백그라운드로 주기적으로 수집해 여기에 넣어두고, /report는 여기서 읽기만 한다.
 *
 * 정기 발송(src/index.ts)은 이 캐시를 쓰지 않는다 — 그건 항상 최신이어야 한다.
 */
const CACHE_DIR = path.resolve(process.cwd(), "cache");

function cachePath(lookbackDays: number): string {
  return path.join(CACHE_DIR, `report-${lookbackDays}d.json`);
}

interface CachedPayload {
  savedAt: string;
  lookbackDays: number;
  input: ReportInput;
}

export interface CachedReport {
  input: ReportInput;
  /** 수집 시점으로부터 흐른 시간(ms) */
  ageMs: number;
  savedAt: Date;
}

/** JSON을 거치면 Date가 문자열이 되므로 되살린다. */
function reviveDates(input: ReportInput): ReportInput {
  return {
    ...input,
    generatedAt: new Date(input.generatedAt),
    window: {
      begin: new Date(input.window.begin),
      end: new Date(input.window.end),
    },
  };
}

export async function saveReportInput(input: ReportInput, lookbackDays: number): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const payload: CachedPayload = {
      savedAt: new Date().toISOString(),
      lookbackDays,
      input,
    };
    await writeFile(cachePath(lookbackDays), JSON.stringify(payload), "utf-8");
    logger.debug("수집 결과 캐시 저장", { lookbackDays });
  } catch (err) {
    // 캐시 저장 실패는 기능을 막을 이유가 없다 — 다음 조회가 느려질 뿐이다.
    logger.warn("수집 결과 캐시 저장 실패", { error: String(err) });
  }
}

/**
 * 저장된 수집 결과를 읽는다.
 * maxAgeMs를 넘긴 캐시도 그대로 돌려준다 — "오래됐다"는 판단은 호출부가 한다.
 * 화면에 몇 분 전 기준인지 표시해야 하므로 나이를 숨기지 않는다.
 */
export async function loadReportInput(lookbackDays: number): Promise<CachedReport | null> {
  try {
    const raw = await readFile(cachePath(lookbackDays), "utf-8");
    const payload = JSON.parse(raw) as CachedPayload;
    const savedAt = new Date(payload.savedAt);
    return {
      input: reviveDates(payload.input),
      ageMs: Date.now() - savedAt.getTime(),
      savedAt,
    };
  } catch {
    // 파일이 없는 게 정상 상태다 (처음 실행). 오류로 시끄럽게 만들지 않는다.
    return null;
  }
}

/** "3분 전" 처럼 사람이 읽는 표기 */
export function formatAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}
