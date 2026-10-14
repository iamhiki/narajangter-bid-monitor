import { readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { MatchedNotice } from "./types.js";

/**
 * 시·도 이름을 두 글자 약칭으로 — "강원특별자치도"/"강원도"/"강원"을 같은 지역으로 본다.
 * 충청·전라·경상은 둘째 글자 대신 북/남을 붙인다 (충청북도 → 충북).
 */
export function regionKey(name: string): string {
  const s = name.replace(/\s/g, "");
  const m = /^(충청|전라|경상)(북|남)/.exec(s);
  return m ? `${m[1]!.charAt(0)}${m[2]}` : s.slice(0, 2);
}

/**
 * 지역제한으로 지일이 참가할 수 없는 본공고를 뺀다 (2026-10-14 요청: "경상남도 한정 같은 공고는 수집하지 않아도 됨").
 *
 * 참가 가능 지역은 나라장터 참가가능지역정보(api/regionLimitApi.ts)에서 온다. 지역제한은 본점 소재지
 * 기준이라 company-profile.json의 headquartersRegion(강원특별자치도)과 시·도 단위로 비교한다.
 *
 * 보수적으로 거른다 — 확실히 참가할 수 없을 때만 뺀다:
 *  - 참가 가능 지역 중 하나라도 본점과 같은 시·도면 남긴다. "강원특별자치도 횡성군"처럼 시·군까지
 *    좁힌 공고는 본점 시·군이 다르면 실제로는 못 들어가지만, 본점 시·군을 따로 두지 않았으니 남겨서
 *    담당자가 본다.
 *  - 지역 정보가 없거나(지역제한 없음·조회 실패) 본점 소재지를 모르면 거르지 않는다.
 */
export function isOutsideRegion(regions: readonly string[] | undefined, headquartersRegion: string | null): boolean {
  if (!headquartersRegion || !regions || regions.length === 0) return false;
  const hq = regionKey(headquartersRegion);
  // "전남광주통합특별시 목포시" → 앞의 시·도만 본다
  return !regions.some((r) => regionKey(r.trim().split(/\s+/)[0] ?? "") === hq);
}

/** 본점 소재지 (config/company-profile.json). 파일이 없거나 값이 없으면 null — 지역으로 거르지 않는다. */
export function loadHeadquartersRegion(): string | null {
  try {
    const dir = process.env.APP_CONFIG_DIR ? path.resolve(process.env.APP_CONFIG_DIR) : path.resolve("config");
    const profile = JSON.parse(readFileSync(path.join(dir, "company-profile.json"), "utf8")) as { headquartersRegion?: string | null };
    return profile.headquartersRegion ?? null;
  } catch {
    return null;
  }
}

export function applyRegionFilter(
  matches: MatchedNotice[],
  regionsByNotice: Map<string, string[]>,
  headquartersRegion: string | null
): MatchedNotice[] {
  const kept = matches.filter(
    (m) => m.notice.sourceType !== "본공고" || !isOutsideRegion(regionsByNotice.get(m.notice.noticeNo), headquartersRegion)
  );
  logger.info("지역제한 판정 완료", { 대상: matches.length, 지역밖제외: matches.length - kept.length });
  return kept;
}
