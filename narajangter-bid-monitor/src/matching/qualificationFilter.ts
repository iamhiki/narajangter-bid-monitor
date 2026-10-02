import type { LicenseLimitGroup } from "../api/licenseLimitApi.js";
import type { CodeEntry } from "../config/loadJsonConfig.js";

/**
 * 공고의 업종제한과 지일 보유 자격을 대조한다.
 *
 * **코드로 맞춘다.** 이전 구현은 업종 *이름*의 부분일치로 판정했는데, 그게 오탐의 원인이었다:
 *   공고 제한 `건축공사업(0002)`  ↔  보유 `실내건축공사업(0006)`
 *   → "실내건축공사업".includes("건축공사업") 이 참이라 **충족으로 판정**됐다.
 * 두 업종은 전혀 다른 면허이고, 지일은 0002를 보유하지 않는다. 실제로 이 탓에
 * 건축공사업 제한이 걸린 710억 건물 신축공사가 그대로 통과했다.
 *
 * 코드는 4자리 숫자라 부분일치 여지가 없다. 허용업종 문자열이 `업종명/코드` 형태로
 * 오므로(실측: `"정보통신공사업/0036"`) 코드를 떼어 비교한다.
 */

export interface QualificationCheckResult {
  totalGroups: number;
  missingGroups: LicenseLimitGroup[];
  missingCount: number;
  /**
   * 제한그룹 중 하나라도 보유 자격으로 채웠는지. 그룹끼리는 "또는"이다 — 공고문 "다음 각 호 중 어느 하나"
   * (licenseLimitApi.ts LicenseLimitGroup 주석, 2026-09-30 확인. 이전에는 그룹을 모두 채워야 한다고 잘못 보고 있었다).
   * 못 채워도 공고를 빼지는 않는다 — 공동수급이 허용되면 그 자격을 가진 업체와 함께 참가할 수 있어서
   * "미보유"로 표시만 하고 판단은 담당자에게 맡긴다 (회사 방침, 2026-09-30).
   */
  passes: boolean;
  /** 코드를 못 읽어 이름으로 판정할 수밖에 없었던 그룹 수 (진단용) */
  nameFallbackGroups: number;
  /** 충족된 그룹마다 그 그룹을 채운 보유 자격 (화면 표시용) */
  satisfiedBy: SatisfiedQualification[];
}

/**
 * 그룹 하나를 채운 보유 자격.
 * 코드로 맞춘 경우 이름은 보유 자격 목록의 이름을 쓴다. 이름으로만 맞춘 경우(공고 쪽에
 * 코드가 없던 그룹)는 어느 코드인지 특정할 수 없으므로 code가 null이다 —
 * 실내건축공사업처럼 같은 이름에 코드가 둘인 자격도 있어서 추측해 붙이지 않는다.
 */
export interface SatisfiedQualification {
  groupNo: string;
  name: string;
  code: string | null;
}

/**
 * 충족에 쓰인 보유 자격을 한 번씩만, 몇 개 그룹을 채웠는지와 함께 (화면·요약 표시용).
 * satisfiedBy는 그룹×자격 단위라 같은 자격이 그룹 수만큼 들어 있다.
 */
export function uniqueSatisfied(satisfiedBy: SatisfiedQualification[]): { name: string; code: string | null; groups: number }[] {
  const byKey = new Map<string, { name: string; code: string | null; groups: Set<string> }>();
  for (const s of satisfiedBy) {
    const key = s.code ?? s.name;
    const e = byKey.get(key) ?? { name: s.name, code: s.code, groups: new Set<string>() };
    e.groups.add(s.groupNo);
    byKey.set(key, e);
  }
  return [...byKey.values()].map((e) => ({ name: e.name, code: e.code, groups: e.groups.size }));
}

/** `"정보통신공사업/0036"` → `"0036"`. 코드가 없으면 null. */
export function extractCode(allowedName: string): string | null {
  const match = /\/\s*(\d{4})\s*$/.exec(allowedName.trim());
  return match?.[1] ?? null;
}

/**
 * 그룹 하나가 충족되는지 본다. 그룹 안의 허용업종은 OR 조건이다 — 하나만 보유하면 된다.
 *
 * 코드가 붙어 있으면 코드로만 판정한다. 코드가 전혀 없는 그룹(식품위생법상 영업 종류처럼
 * 업종코드 체계가 아닌 경우)에서만 이름 완전일치로 떨어진다 — 부분일치는 쓰지 않는다.
 */
export function isGroupSatisfied(
  group: LicenseLimitGroup,
  heldCodes: ReadonlySet<string>,
  heldNames: ReadonlySet<string>
): { satisfied: boolean; usedNameFallback: boolean; matched: { code: string | null; name: string }[] } {
  // 그룹 안의 순번은 "그리고" — 순번마다 채워야 그룹이 채워진다 (licenseLimitApi.ts LicenseLimitGroup 주석)
  const rows = group.rows && group.rows.length > 0 ? group.rows : [group.allowedNames];
  const matched: { code: string | null; name: string }[] = [];
  let satisfied = true;
  let usedNameFallback = false;
  for (const row of rows) {
    const r = isRowSatisfied(row, heldCodes, heldNames);
    satisfied &&= r.satisfied;
    usedNameFallback ||= r.usedNameFallback;
    matched.push(...r.matched);
  }
  return { satisfied, usedNameFallback, matched: satisfied ? matched : [] };
}

/** 순번 하나 — 제한업종과 허용업종 중 하나만 보유하면 된다 */
function isRowSatisfied(
  names: string[],
  heldCodes: ReadonlySet<string>,
  heldNames: ReadonlySet<string>
): { satisfied: boolean; usedNameFallback: boolean; matched: { code: string | null; name: string }[] } {
  // 채우는 보유 자격을 **전부** 모은다. 첫 번째 것만 남기면, 여러 그룹에 공통으로 들어 있는
  // 업종(예: 1469가 4개 그룹 모두에 있음)이 그룹마다 똑같이 찍혀 "1469, 1469, 1469, 1469"가 된다
  // (2026-09-29 구곡관광길·울진해양과학관 공고 실측). 판정은 하나만 있어도 충족으로 같다.
  const matched: { code: string | null; name: string }[] = [];
  let sawCode = false;

  for (const allowed of names) {
    const code = extractCode(allowed);
    if (code) {
      sawCode = true;
      if (heldCodes.has(code)) matched.push({ code, name: allowed.replace(/\/\s*\d{4}\s*$/, "").trim() });
    }
  }
  if (sawCode) return { satisfied: matched.length > 0, usedNameFallback: false, matched };

  // 코드가 하나도 없는 순번 — 이름 완전일치로만 본다.
  for (const n of names.map((x) => x.trim())) {
    if (heldNames.has(n)) matched.push({ code: null, name: n });
  }
  return { satisfied: matched.length > 0, usedNameFallback: true, matched };
}

/** "업종명/0002" → "업종명(0002)" — 화면·알림에 쓰는 표기 */
export function qualificationLabel(name: string): string {
  return name.trim().replace(/\s*\/\s*(\d{4})\s*$/, "($1)");
}

/**
 * 채우지 못한 그룹(= 참가 방법)마다 필요한 자격 (화면·알림 표시용).
 * text는 그 방법을 사람이 읽는 한 줄: 순번 안은 "또는", 순번끼리는 "+" — 예: "지반조성ㆍ포장공사업(4989) + 상ㆍ하수도설비공사업(4996)"
 */
export function missingLabels(missingGroups: LicenseLimitGroup[]): { groupNo: string; names: string[]; text: string }[] {
  const all = missingGroups.map((g) => ({
    groupNo: g.groupNo,
    rows: (g.rows && g.rows.length > 0 ? g.rows : [g.allowedNames]).map((r) => r.map(qualificationLabel)),
  }));
  // 순번 하나짜리 방법이 다른 순번 하나짜리 방법에 통째로 들어 있으면 뺀다 — 나라장터가 "[건축공사업] 또는
  // [토목건축공사업]"을 그룹1(건축공사업, 허용 토목건축공사업)·그룹2(토목건축공사업)로 겹쳐 싣는 경우
  // (백령 점박이물범 체험관 R26BK01749693). 그대로 두면 "… 또는 토목건축공사업 / 또는 토목건축공사업"이 된다.
  const redundant = (i: number): boolean => {
    const a = all[i]!.rows;
    if (a.length !== 1) return false;
    return all.some((b, j) => {
      if (j === i || b.rows.length !== 1) return false;
      const covers = a[0]!.every((x) => b.rows[0]!.includes(x));
      const same = covers && b.rows[0]!.length === a[0]!.length;
      return covers && (!same || j < i);
    });
  };
  return all
    .filter((_, i) => !redundant(i))
    .map((g) => ({ groupNo: g.groupNo, names: g.rows.flat(), text: g.rows.map((r) => r.join(" 또는 ")).join(" + ") }));
}

/** 자격 하나 — 화면 표기(업종명(코드))와 보유 여부 */
export interface LayoutOption {
  label: string;
  held: boolean;
}
/** 화면 팝업용 묶음. all: 모두 필요(각 줄 하나씩), any: 이 중 하나만 있으면 된다 */
export interface LayoutBlock {
  kind: "all" | "any";
  options: LayoutOption[];
  /** 이 묶음을 채웠는지 */
  met: boolean;
}
/**
 * 화면 팝업용 자격 구조. 나라장터는 참가 방법(그룹)마다 필요한 업종을 통째로 되풀이해 싣는다 —
 * 예: 울산과학관 R26BK…은 그룹 4개가 모두 "1469 + 4990 + 산업디자인 한 분야"다. 그대로 보여 주면
 * 같은 업종이 네 번 나오거나(예전) 구조 없이 한 줄씩 늘어놓게 된다. 그래서
 *  · 모든 그룹에 공통인 순번 → "모두 필요" (허용업종이 여럿인 순번은 따로 "이 중 하나")
 *  · 그룹마다 다른 순번이 하나씩뿐이면 → 그것들을 모아 "이 중 하나"
 * 로 묶는다. 그룹마다 다른 부분이 두 순번 이상이면 깔끔하게 묶을 수 없어 methods로 방법별 그대로 준다.
 */
export interface QualificationLayout {
  blocks: LayoutBlock[];
  /** 묶을 수 없는 경우: 참가 방법마다 [순번별 선택지] — 방법끼리 "또는", 순번끼리 "+" */
  methods: LayoutOption[][][] | null;
}

export function qualificationLayout(
  groups: LicenseLimitGroup[],
  heldProducts: CodeEntry[],
  heldIndustries: CodeEntry[]
): QualificationLayout {
  const held = [...heldProducts, ...heldIndustries];
  const heldCodes = new Set(held.map((c) => c.code.trim()));
  const heldNames = new Set(held.map((c) => c.name.trim()));
  const option = (raw: string): LayoutOption => {
    const code = extractCode(raw);
    return { label: qualificationLabel(raw), held: code ? heldCodes.has(code) : heldNames.has(raw.trim()) };
  };
  const rowKey = (r: string[]) => r.map(qualificationLabel).sort().join("|");
  // 순번 안 허용업종 중복 제거, 같은 순번이 두 번 들어간 그룹도 한 번만
  const norm = groups.map((g) => {
    const rows = (g.rows && g.rows.length > 0 ? g.rows : [g.allowedNames]).map((r) => [...new Set(r)]);
    return [...new Map(rows.map((r) => [rowKey(r), r])).values()];
  });
  const uniqGroups = [...new Map(norm.map((rows) => [rows.map(rowKey).sort().join("/"), rows])).values()];
  if (uniqGroups.length === 0) return { blocks: [], methods: null };

  const anyBlock = (opts: LayoutOption[]): LayoutBlock => ({ kind: "any", options: opts, met: opts.some((o) => o.held) });
  const commonKeys = uniqGroups.slice(1).reduce(
    (keys, rows) => new Set([...keys].filter((k) => rows.some((r) => rowKey(r) === k))),
    new Set(uniqGroups[0]!.map(rowKey))
  );
  const commonRows = uniqGroups[0]!.filter((r) => commonKeys.has(rowKey(r)));
  const rests = uniqGroups.map((rows) => rows.filter((r) => !commonKeys.has(rowKey(r))));

  const blocks: LayoutBlock[] = [];
  const singles = commonRows.filter((r) => r.length === 1).map((r) => option(r[0]!));
  if (singles.length) blocks.push({ kind: "all", options: singles, met: singles.every((o) => o.held) });
  for (const r of commonRows.filter((r) => r.length > 1)) blocks.push(anyBlock(r.map(option)));

  // 공통 부분만으로 채워지는 그룹이 있으면 나머지 그룹은 그보다 요건이 많을 뿐이라 볼 필요가 없다
  if (rests.some((r) => r.length === 0)) return { blocks, methods: null };
  const slots = productSlots(rests);
  if (slots) {
    for (const slot of slots) {
      const seen = new Set<string>();
      blocks.push(anyBlock(slot.flat().map(option).filter((o) => !seen.has(o.label) && (seen.add(o.label), true))));
    }
    return { blocks, methods: null };
  }
  return { blocks, methods: rests.map((rows) => rows.map((r) => r.map(option))) };
}

/**
 * 그룹마다 다른 부분이 "자리별 선택지의 모든 조합"이면 자리별로 나눠 준다. 나라장터는
 * "4990 + (1468 또는 1469) + (4442 또는 4444)"를 조합마다 그룹 하나씩, 4개 그룹으로 싣는다
 * (R26BK01662507 실측). 함께 나오는 일이 없는 순번끼리 한 자리로 모은 뒤, 그룹이 정확히
 * 자리마다 하나씩 고른 모든 조합인지 확인한다. 아니면 null — 방법별로 그대로 보여 줘야 한다.
 */
function productSlots(rests: string[][][]): string[][][] | null {
  const key = (r: string[]) => r.map(qualificationLabel).sort().join("|");
  const rowsByKey = new Map<string, string[]>();
  const groupKeys = rests.map((rows) => new Set(rows.map((r) => (rowsByKey.set(key(r), r), key(r)))));
  const together = (a: string, b: string) => groupKeys.some((g) => g.has(a) && g.has(b));
  const slots: string[][] = [];
  for (const k of rowsByKey.keys()) {
    const slot = slots.find((s) => s.every((m) => !together(m, k)));
    if (slot) slot.push(k);
    else slots.push([k]);
  }
  const everyGroupOnePerSlot = groupKeys.every((g) => g.size === slots.length && slots.every((s) => s.filter((k) => g.has(k)).length === 1));
  const combos = slots.reduce((n, s) => n * s.length, 1);
  if (!everyGroupOnePerSlot || combos !== rests.length) return null;
  return slots.map((s) => s.map((k) => rowsByKey.get(k)!));
}

/**
 * 공고의 자격조건(제한그룹) 목록과 보유 자격을 대조한다.
 * 그룹이 없으면(=자격조건 정보가 없거나 조회 실패) 항상 통과시킨다 (fail-open).
 */
export function evaluateQualifications(
  groups: LicenseLimitGroup[],
  heldProducts: CodeEntry[],
  heldIndustries: CodeEntry[]
): QualificationCheckResult {
  const held = [...heldProducts, ...heldIndustries];
  const heldCodes = new Set(held.map((c) => c.code.trim()));
  const heldNames = new Set(held.map((c) => c.name.trim()));
  const heldNameByCode = new Map(held.map((c) => [c.code.trim(), c.name.trim()]));

  const unmet: LicenseLimitGroup[] = [];
  const satisfiedBy: SatisfiedQualification[] = [];
  let nameFallbackGroups = 0;

  for (const group of groups) {
    const { satisfied, usedNameFallback, matched } = isGroupSatisfied(group, heldCodes, heldNames);
    if (usedNameFallback) nameFallbackGroups += 1;
    if (!satisfied) unmet.push(group);
    for (const m of matched) {
      const name = (m.code && heldNameByCode.get(m.code)) || m.name;
      satisfiedBy.push({ groupNo: group.groupNo, name, code: m.code });
    }
  }

  // 그룹끼리는 "또는" — 하나라도 채우면 참가할 수 있다. 못 채웠으면 모든 그룹이 "이 중 하나가 필요"한 선택지다.
  const passes = groups.length === 0 || unmet.length < groups.length;
  const missingGroups = passes ? [] : unmet;
  return {
    totalGroups: groups.length,
    missingGroups,
    missingCount: missingGroups.length,
    passes,
    nameFallbackGroups,
    satisfiedBy,
  };
}
