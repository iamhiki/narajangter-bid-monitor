import type { NormalizedNotice } from "./types.js";
import type { NoticeAttachment } from "./attachments.js";
import { logger } from "../logger.js";

/**
 * 국방전자조달(d2b.go.kr)에만 첨부가 있는 사전규격의 첨부 목록.
 *
 * 국군재정관리단·해군군수사령부 같은 군 기관의 사전규격은 나라장터에 "연계기관 규격"으로만 올라온다 —
 * OpenAPI의 specDocFileUrl1~5가 비어 있고, 나라장터 상세 화면도 첨부 0건에 "d2b.go.kr에서 확인하라"는
 * 안내만 있다. 실제 파일은 국방전자조달 사전규격(군부대) 상세 화면에 있다 (2026-10-12 실측:
 * R26BD00281727 상설육군홍보관 → d2b 판단번호 40015, "사전규격공개(26F175-B).zip" 안에 제안요청서·공고문).
 *
 * 나라장터 참조번호(refNo)가 "PS" + 연도 + 부서부호 + 판단번호 꼴이다 (PS2026UMM40015).
 * 흐름: 목록 화면(세션 쿠키) → 목록 JSON으로 업무구분(lv1Divs) 확인 → 상세 화면 → 첨부 링크.
 * 첨부는 그 세션 쿠키가 있어야 받아져서(없으면 "비정상 접근" HTML) 쿠키를 첨부에 실어 보낸다.
 *
 * **공식 API가 아니라 화면을 읽는다.** 화면 구조가 바뀌면 빈 목록이 되고, 그때는 예전처럼
 * "확인 안 됨"으로 남는다 — 부가 정보라 실패해도 다른 처리를 막지 않는다.
 */

const D2B = "https://www.d2b.go.kr";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const TIMEOUT_MS = 15_000;
/** 세션이 살아 있는 동안만 같은 결과를 쓴다 — 첨부 캐시에 없는 파일은 이 쿠키로 받는다 */
const MEMO_MS = 10 * 60_000;

export interface D2bRef {
  year: string;
  dprtCode: string;
  dcsnNumb: string;
}

/** 나라장터 참조번호(refNo)에서 국방전자조달 사전규격 번호를 꺼낸다. 군 기관 규격이 아니면 null */
export function d2bRefOf(notice: NormalizedNotice): D2bRef | null {
  const raw = (notice.raw ?? {}) as Record<string, unknown>;
  const m = String(raw.refNo ?? "").trim().match(/^PS(\d{4})([A-Z0-9]{3})([0-9-]+)$/);
  return m ? { year: m[1]!, dprtCode: m[2]!, dcsnNumb: m[3]! } : null;
}

/** 상세 화면 HTML에서 첨부 링크와 파일명 */
export function parseD2bAttachmentLinks(html: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const m of html.matchAll(/href="(\/common\/downloadSes\.do\?fileIdxx=[A-Za-z0-9]+)"[^>]*>\s*([^<]+?)\s*</g)) {
    out.push({ path: m[1]!, name: m[2]!.replace(/&amp;/g, "&").trim() });
  }
  return out;
}

const memo = new Map<string, { at: number; list: Promise<NoticeAttachment[]> }>();

/** 국방전자조달 사전규격 첨부. 군 기관 규격이 아니거나 못 찾으면 빈 배열 */
export function d2bAttachmentsFor(notice: NormalizedNotice): Promise<NoticeAttachment[]> {
  const ref = d2bRefOf(notice);
  if (!ref) return Promise.resolve([]);
  const key = `${ref.year}${ref.dprtCode}${ref.dcsnNumb}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.list;
  const list = fetchAttachments(notice, ref).catch((err) => {
    logger.debug?.("국방전자조달 첨부 조회 실패", { noticeNo: notice.noticeNo, error: String(err) });
    return [];
  });
  memo.set(key, { at: Date.now(), list });
  return list;
}

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
}

/** "2026-10-06 21:37:05" → Date. 못 읽으면 지금 */
function rcptDate(notice: NormalizedNotice): Date {
  const raw = (notice.raw ?? {}) as Record<string, unknown>;
  const s = String(raw.rcptDt ?? raw.rgstDt ?? "").trim();
  const d = new Date(s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function fetchAttachments(notice: NormalizedNotice, ref: D2bRef): Promise<NoticeAttachment[]> {
  const signal = () => AbortSignal.timeout(TIMEOUT_MS);
  const listPage = await fetch(`${D2B}/psb/plan/servicePreStdList.do`, { headers: { "User-Agent": UA }, signal: signal() });
  const cookie = cookieOf(listPage);
  const form = { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) };

  // 상세 화면에 업무구분(PDB 용역 / PEB 시설공사 …)이 필요한데 참조번호엔 없어 목록에서 찾는다
  const at = rcptDate(notice);
  const search = new URLSearchParams({
    from_month: ymd(new Date(at.getTime() - 14 * 86_400_000)),
    to_month: ymd(new Date(at.getTime() + 14 * 86_400_000)),
    dcsn_numb: ref.dcsnNumb,
    exct_divs: "A",
    currentPageNo: "1",
  });
  const listRes = await fetch(`${D2B}/psb/plan/getPreStdList.json`, { method: "POST", headers: form, body: search, signal: signal() });
  const rows = ((await listRes.json()) as { list?: { lv1Divs: string; dprtCode: string; ordrYear: string; dcsnNumb: string }[] }).list ?? [];
  const row = rows.find((r) => r.dprtCode === ref.dprtCode && r.ordrYear === ref.year && r.dcsnNumb === ref.dcsnNumb);
  if (!row) {
    logger.debug?.("국방전자조달 목록에 없음", { noticeNo: notice.noticeNo, ref });
    return [];
  }

  const view = await fetch(`${D2B}/pdb/plan/preStdView.do`, {
    method: "POST",
    headers: form,
    body: new URLSearchParams({ ordr_year: ref.year, dprt_code: ref.dprtCode, dcsn_numb: ref.dcsnNumb, lv1_divs: row.lv1Divs }),
    signal: signal(),
  });
  if (!view.ok) return [];
  const sessionCookie = [cookie, cookieOf(view)].filter(Boolean).join("; ");
  return parseD2bAttachmentLinks(await view.text()).map((a) => ({
    name: a.name,
    url: `${D2B}${a.path}`,
    isSpec: true,
    headers: { "User-Agent": UA, Referer: `${D2B}/pdb/plan/preStdView.do`, ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
  }));
}
