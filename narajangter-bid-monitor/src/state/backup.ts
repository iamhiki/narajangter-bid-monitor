import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { logger } from "../logger.js";

/**
 * 판단 기록처럼 이 PC에만 있는 파일을 PC 밖 폴더에 한 부 더 둔다 (2026-10-19 요청 — PC가 고장 나면 기록이 사라지는 문제).
 *
 * 백업 폴더는 회사 구글 드라이브 데스크톱이 동기화하는 폴더를 가리킨다 (UI_BACKUP_DIR). 파일을 그 폴더에 쓰면
 * 구글 드라이브가 알아서 올린다 — 이 코드는 구글 API를 쓰지 않는다. 드라이브가 파일의 예전 버전을 30일 보관하고,
 * 여기서도 날짜별 사본을 KEEP_DAYS일 남겨 실수로 지운 기록을 되살릴 수 있게 한다.
 *
 * 백업이 실패해도 저장은 그대로 된다 — 경고만 남긴다 (드라이브가 잠깐 끊겨도 판단을 못 누르면 안 된다).
 */
const KEEP_DAYS = 30;
const DAILY_DIR = "날짜별";

/** 한국 날짜 (YYYY-MM-DD) — 날짜별 사본 이름 */
function kstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 방금 저장한 파일 내용을 백업 폴더에 쓴다: 최신본(같은 이름) + 그날 날짜 사본(하루 동안 덮어씀).
 * 원본 파일을 다시 읽지 않고 저장한 내용을 그대로 받는다 — 복사 도중 다른 저장이 끼어들어도 반쯤 쓴 파일이 올라가지 않게.
 * daily: false면 최신본만 쓴다 (판단기록.csv처럼 보기용 파일 — 날짜별로 남길 필요가 없다).
 */
export function backupContent(fileName: string, content: string, backupDir: string | null, now = new Date(), daily = true): void {
  if (!backupDir) return;
  try {
    mkdirSync(join(backupDir, DAILY_DIR), { recursive: true });
    writeFileSync(join(backupDir, fileName), content, "utf8");
    if (!daily) return;
    const ext = extname(fileName);
    const stem = basename(fileName, ext);
    writeFileSync(join(backupDir, DAILY_DIR, `${stem}-${kstDate(now)}${ext}`), content, "utf8");
    pruneDaily(join(backupDir, DAILY_DIR), now);
  } catch (err) {
    logger.warn("백업 폴더에 쓰지 못했습니다 — 이 PC에는 저장됐습니다", { backupDir, fileName, error: String(err) });
  }
}

/** 날짜별 사본 중 KEEP_DAYS일보다 오래된 것을 지운다 (파일 이름의 날짜 기준) */
function pruneDaily(dir: string, now: Date): void {
  const cutoff = kstDate(new Date(now.getTime() - KEEP_DAYS * 86400_000));
  for (const name of readdirSync(dir)) {
    const date = /-(\d{4}-\d{2}-\d{2})\.[^.]+$/.exec(name)?.[1];
    if (date && date < cutoff) unlinkSync(join(dir, name));
  }
}

/**
 * 이 PC에 파일이 없고 백업 폴더에 있으면 백업을 가져온다 — 새 PC에 설치했거나 cache 폴더가 지워졌을 때.
 * 이 PC에 파일이 있으면 건드리지 않는다 (이 PC 쪽이 항상 최신이다). 가져왔으면 true.
 */
export function restoreIfMissing(localPath: string, backupDir: string | null): boolean {
  if (!backupDir || existsSync(localPath)) return false;
  const source = join(backupDir, basename(localPath));
  try {
    if (!existsSync(source) || statSync(source).size === 0) return false;
    copyFileSync(source, localPath);
    logger.info("이 PC에 기록이 없어 백업 폴더에서 가져왔습니다", { from: source, to: localPath });
    return true;
  } catch (err) {
    logger.warn("백업 폴더에서 기록을 가져오지 못했습니다", { from: source, error: String(err) });
    return false;
  }
}
