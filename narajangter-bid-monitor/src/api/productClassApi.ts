import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../logger.js";

/**
 * 조달청 물품목록정보서비스 — 세부품명번호(10자리)의 이름·해설과 상위 분류 이름.
 *
 * 세부품명번호 10자리 = 물품분류번호 8자리(대분류 2 · 중분류 2 · 소분류 2 · 품명 2) + 세부 2자리.
 * 공고문에는 "교육훈련장비(6010999901)"처럼 번호 하나만 나오는데, 이 서비스로 각 단계 이름과
 * 해설("각종 훈련 및 교육에 사용되는 장비")을 붙이면 미보유 품목이 지일 보유 품목과 얼마나
 * 가까운지, 무엇을 뜻하는지 바로 읽힌다.
 *
 * 입찰공고 API와 별도 서비스라 공공데이터포털에서 따로 활용신청해야 한다(2026-09-29 승인).
 * 오퍼레이션 이름은 전부 "02"로 끝난다 — 공개 검색으로는 안 나오고 포털 페이지에 박힌 명세에서 확인했다.
 * 직접생산확인 대상·중소기업자간 경쟁제품 여부는 이 서비스 응답에 없다.
 *
 * 분류 체계는 거의 바뀌지 않으므로 cache/product-class.json에 남겨 두고 다시 묻지 않는다.
 */

export const PRODUCT_CLASS_BASE_URL = "https://apis.data.go.kr/1230000/ao/ThngListInfoService02";

export interface ClassLevel {
  /** 자릿수: 2 대분류, 4 중분류, 6 소분류, 8 품명, 10 세부품명 */
  digits: 2 | 4 | 6 | 8 | 10;
  code: string;
  name: string;
  description: string | null;
}

export interface ProductClassInfo {
  code: string;
  /** 대분류 → 세부품명 순서. 조회에 실패한 단계는 빠진다 */
  levels: ClassLevel[];
}

const LEVELS: { digits: ClassLevel["digits"]; op: string; kind: "dtil" | "prdct" }[] = [
  { digits: 2, op: "getPrdctClsfcNoUnit2Info02", kind: "prdct" },
  { digits: 4, op: "getPrdctClsfcNoUnit4Info02", kind: "prdct" },
  { digits: 6, op: "getPrdctClsfcNoUnit6Info02", kind: "prdct" },
  { digits: 8, op: "getPrdctClsfcNoUnit8Info02", kind: "prdct" },
  { digits: 10, op: "getPrdctClsfcNoUnit10Info02", kind: "dtil" },
];

const CACHE_PATH = resolve("cache/product-class.json");
let cache: Record<string, ClassLevel | null> | null = null;

function loadCache(): Record<string, ClassLevel | null> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, ClassLevel | null>;
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache(): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1), "utf8");
  } catch {
    /* 캐시를 못 써도 조회 결과는 이번에 그대로 쓴다 */
  }
}

/** 응답 한 건을 ClassLevel로. 응답 형태는 2026-09-29 실측 JSON 그대로다. */
export function parseLevel(json: unknown, digits: ClassLevel["digits"]): ClassLevel | null {
  const items = (json as { response?: { body?: { items?: unknown } } })?.response?.body?.items;
  const list = Array.isArray(items) ? items : items && typeof items === "object" ? [((items as { item?: unknown }).item ?? items)] : [];
  const it = list.flat()[0] as Record<string, string> | undefined;
  if (!it) return null;
  const code = digits === 10 ? it.dtilPrdctClsfcNo : it.prdctClsfcNo;
  const name = digits === 10 ? it.dtilPrdctClsfcNoNm : it.prdctClsfcNoNm;
  const desc = digits === 10 ? it.dtilPrdctClsfcNoNmDscrpt : it.prdctClsfcNoNmDscrpt;
  if (!code || !name) return null;
  return { digits, code, name, description: desc?.trim() || null };
}

async function fetchLevel(serviceKey: string, code: string, level: (typeof LEVELS)[number], timeoutMs: number): Promise<ClassLevel | null> {
  const store = loadCache();
  if (code in store) return store[code] ?? null;

  const url = new URL(`${PRODUCT_CLASS_BASE_URL}/${level.op}`);
  const range = level.kind === "dtil" ? ["dtilPrdctClsfcNoBgnNo", "dtilPrdctClsfcNoEndNo"] : ["prdctClsfcNoBgnNo", "prdctClsfcNoEndNo"];
  for (const [k, v] of Object.entries({ serviceKey, numOfRows: "1", pageNo: "1", type: "json", [range[0]!]: code, [range[1]!]: code })) {
    url.searchParams.set(k, v);
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      // 활용신청 전이면 403(등록되지 않은 서비스키). 없는 번호로 캐시하면 안 되므로 저장하지 않는다.
      logger.debug?.("물품분류 조회 실패", { code, status: res.status });
      return null;
    }
    const parsed = parseLevel(await res.json(), level.digits);
    store[code] = parsed; // 정상 응답인데 항목이 없으면 null로 남겨 다시 묻지 않는다
    saveCache();
    return parsed;
  } catch (err) {
    logger.debug?.("물품분류 조회 중 오류", { code, error: String(err) });
    return null;
  }
}

/** 세부품명번호 하나의 분류 경로 (대분류 → 세부품명). 서비스키가 없거나 전부 실패하면 null. */
export async function lookupProductClass(
  serviceKey: string,
  code10: string,
  options: { timeoutMs?: number } = {}
): Promise<ProductClassInfo | null> {
  if (!/^\d{10}$/.test(code10) || !serviceKey) return null;
  const levels: ClassLevel[] = [];
  for (const level of LEVELS) {
    const found = await fetchLevel(serviceKey, code10.slice(0, level.digits), level, options.timeoutMs ?? 15_000);
    if (found) levels.push(found);
  }
  return levels.length ? { code: code10, levels } : null;
}
