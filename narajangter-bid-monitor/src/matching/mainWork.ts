import type { NormalizedNotice } from "../api/types.js";
import type { CodeEntry } from "../config/loadJsonConfig.js";

/**
 * 공사 공고의 주공종(mainCnsttyNm)과 지일 보유 여부.
 *
 * 주공종은 그 공사가 무슨 일인지 바로 보여준다 — 2026-10-01 리스트의 공사 12건 중 실내건축공사업은
 * 2건뿐이고 나머지는 조경식재·시설물공사업(놀이터 조성), 조경공사업(실내정원), 건축공사업 등이었다.
 * **빼지 않고 배지로만 보여준다** — 공동수급으로 참가할 수 있어 판단은 담당자에게 맡긴다
 * (자격 미충족 공고를 빼지 않는 것과 같은 방침, 2026-09-30·10-01).
 */
export interface MainWork {
  name: string;
  held: boolean;
}

/** "조경식재ㆍ시설물공사업"과 "조경식재·시설물공사업"처럼 가운뎃점·공백만 다른 표기를 같게 본다 */
const norm = (s: string) => s.replace(/[\s·‧ㆍ∙・•.]+/g, "");

export function mainWorkOf(notice: NormalizedNotice, heldIndustries: CodeEntry[]): MainWork | null {
  if (notice.businessType !== "공사") return null;
  const raw = (notice.raw ?? {}) as Record<string, unknown>;
  const name = typeof raw["mainCnsttyNm"] === "string" ? raw["mainCnsttyNm"].trim() : "";
  if (!name) return null;
  const held = heldIndustries.some((h) => norm(h.name) === norm(name));
  return { name, held };
}
