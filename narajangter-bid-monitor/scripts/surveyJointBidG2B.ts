/**
 * PoC3(공동수급 허용여부 선확인 로직) 검증용 — "방법1: 데이터 엔드포인트 직접 호출" 결과물.
 *
 * ## 배경 (중요 — surveyJointBid.ts의 전제가 틀렸음)
 * 기존 scripts/surveyJointBid.ts 는 "공동수급협정서 제출 및 구성방식" 값이
 * fetchBidNotices()가 부르는 data.go.kr 나라장터 OpenAPI의 원본 응답(raw) 어딘가에
 * 있을 것이라 가정하고 키워드로 후보 필드를 찾는 방식이었다.
 *
 * 그런데 실제로 g2b.go.kr 웹 화면(입찰공고 상세 팝업)을 열어 네트워크 탭을 직접 캡처해보니,
 * 이 값은 data.go.kr OpenAPI 응답에는 **아예 존재하지 않고**, g2b.go.kr 웹 화면이 별도로
 * 아래의 자체 데이터 API를 호출해서 받아온다는 것을 확인했다 (2026-09-14, 실제 브라우저로 검증):
 *
 *   POST https://www.g2b.go.kr/pn/pnp/pnpe/ItemBidPbac/selectItemAnncMngV.do
 *   Content-Type: application/json;charset=UTF-8
 *   Body: {"dmItemMap": {"bidPbancNo": "<입찰공고번호>", "bidPbancOrd": "<공고차수, 통상 000>"}}
 *
 * 응답 JSON의 `dmItemMap.jintCtrtCmnMthoNm` 필드가 화면에 보이는
 * "공동수급협정서 제출 및 구성방식" 값이다 (HTML 엔티티로 괄호가 인코딩되어 있어 디코딩 필요:
 * 예) "&#40;없음&#41;공동수급불허" → "(없음)공동수급불허").
 *
 * 아래 3건으로 교차 검증 완료 (모두 실제 공고명이 정확히 매칭됨):
 *   - R26BK01720867 → "(없음)공동수급불허"
 *   - R26BK01695832 → "(수기)공동이행 또는 분담이행"
 *   - R26BK01694102 → "(전자)분담이행"
 *
 * 이 방식(Method 1)이 Playwright DOM 스크레이핑(Method 2)보다 나은 이유:
 *   - 공고 유형(물품/용역/공사)마다 상세화면 HTML 구조·필드 개수가 달라도, 이 JSON API는
 *     "필요한 필드만 넣어도 dmItemMap 전체를 다 채워서" 응답하므로 구조 변화에 영향을 안 받는다.
 *   - 브라우저 렌더링이 필요 없어 훨씬 빠르고 가볍다 (건당 HTTP 요청 1회).
 *
 * ## 이 파일의 위치
 * data.go.kr(narajangter-bid-monitor의 fetchBidNotices)과 g2b.go.kr 상세 API는
 * 완전히 다른 시스템이라, 이 스크립트는 기존 src/ 코드를 건드리지 않고
 * (필요하면 fetchBidNotices로 얻은 공고번호 목록만 재사용) 완전히 독립적으로 동작한다.
 * 필요 없어지면 이 파일만 지우면 됨.
 *
 * ## 중요한 한계 / 확인 필요 사항
 * - Claude 샌드박스에서는 www.g2b.go.kr 자체가 방화벽에 막혀 있어(apis.data.go.kr과 동일한
 *   조직 정책) 이 스크립트를 이 환경에서 실행할 수 없었다. 반드시 사용자 PC 또는
 *   GitHub Actions처럼 실제 인터넷이 열려있는 환경에서 실행해야 한다.
 * - bidPbancOrd(공고차수)는 브라우저 캡처 당시 항상 "000"이었다. 정정공고로 차수가 올라간 건은
 *   다를 수 있는데, data.go.kr raw 응답에 차수 필드(예: bidNtceOrd류)가 있으면 그걸 쓰고,
 *   없으면 "000"으로 시도한다 — 실패하면 결과에 실패 사유(ErrorMsg)가 그대로 나오니 확인할 것.
 * - 이 API가 별도 로그인/세션을 요구하는지도 브라우저의 기존 쿠키가 섞인 상태에서 확인한 것이라
 *   완전한 비로그인 상태에서도 항상 되는지는 100% 장담 못 한다. 아래 코드는 방어적으로
 *   먼저 홈페이지에 GET을 날려 세션 쿠키를 확보한 뒤 그 쿠키를 붙여서 호출한다.
 *
 * ## 사용법
 *   # 1) 공고번호를 직접 나열해서 조사 (빠른 확인용)
 *   npx tsx scripts/surveyJointBidG2B.ts R26BK01720867 R26BK01695832 R26BK01694102
 *
 *   # 2) 인자 없이 실행하면 기존 fetchBidNotices()로 최근 lookbackDays(.env) 기간의
 *      실제 매칭 대상 공고를 가져와서 전부 조사 (PoC3 표본 분포 확보용, 이게 진짜 목적)
 *   npx tsx scripts/surveyJointBidG2B.ts
 *   npx tsx scripts/surveyJointBidG2B.ts --days 30
 *   npx tsx scripts/surveyJointBidG2B.ts --days 3 --limit 30   # g2b.go.kr 부하/소요시간 제한용 표본 개수 상한
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEnv } from "../src/config/env.js";
import { lookbackWindow } from "../src/api/dateUtil.js";
import { fetchBidNotices } from "../src/api/bidNoticeApi.js";

const G2B_HOME = "https://www.g2b.go.kr/";
const G2B_DETAIL_API = "https://www.g2b.go.kr/pn/pnp/pnpe/ItemBidPbac/selectItemAnncMngV.do";

/** data.go.kr raw 응답에 공고차수 필드가 있을 경우의 후보 키 (미확인 — 있으면 우선 사용, 없으면 "000") */
const ORD_FIELD_CANDIDATES = ["bidNtceOrd", "ntceOrd", "bidPbancOrd"];

interface JointBidResult {
  noticeNo: string;
  ord: string;
  businessType?: string;
  ok: boolean;
  bidPbancNm?: string | null;
  jointBidValue?: string;
  reason?: string;
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&#40;/g, "(").replace(/&#41;/g, ")").replace(/&amp;/g, "&");
}

function guessOrd(raw: Record<string, unknown>): string {
  for (const key of ORD_FIELD_CANDIDATES) {
    const v = raw[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim().padStart(3, "0");
    if (typeof v === "number") return String(v).padStart(3, "0");
  }
  return "000";
}

async function getSessionCookie(): Promise<string> {
  try {
    const res = await fetch(G2B_HOME, { method: "GET" });
    return res.headers.get("set-cookie") ?? "";
  } catch {
    return "";
  }
}

async function fetchJointBidField(
  noticeNo: string,
  ord: string,
  cookie: string,
  businessType?: string
): Promise<JointBidResult> {
  const res = await fetch(G2B_DETAIL_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ dmItemMap: { bidPbancNo: noticeNo, bidPbancOrd: ord } }),
  });

  if (!res.ok) {
    return { noticeNo, ord, businessType, ok: false, reason: `HTTP ${res.status}` };
  }

  const json: any = await res.json();
  if (json?.ErrorMsg && json.ErrorMsg !== "정상적으로 조회되었습니다.") {
    return { noticeNo, ord, businessType, ok: false, reason: json.ErrorMsg };
  }

  const raw = json?.dmItemMap?.jintCtrtCmnMthoNm ?? null;
  return {
    noticeNo,
    ord,
    businessType,
    ok: true,
    bidPbancNm: json?.dmItemMap?.bidPbancNm ? decodeHtmlEntities(json.dmItemMap.bidPbancNm) : null,
    jointBidValue: raw ? decodeHtmlEntities(raw) : "(필드 없음/null)",
  };
}

const KNOWN_FLAGS = new Set(["--days", "--limit"]);

/** "--days"/"--limit"와 그 값 뒤에 오는 토큰을 제외한, 순수 공고번호 인자만 추린다. */
function extractExplicitNoticeNos(cliArgs: string[]): string[] {
  const nos: string[] = [];
  for (let i = 0; i < cliArgs.length; i++) {
    const a = cliArgs[i];
    if (a === undefined) continue;
    if (KNOWN_FLAGS.has(a)) {
      i++; // 다음 토큰은 이 플래그의 값이므로 공고번호 후보에서 제외
      continue;
    }
    if (a.startsWith("--")) continue;
    nos.push(a);
  }
  return nos;
}

async function collectTargets(
  cliArgs: string[]
): Promise<Array<{ noticeNo: string; ord: string; businessType?: string }>> {
  const explicitNos = extractExplicitNoticeNos(cliArgs);
  if (explicitNos.length > 0) {
    return explicitNos.map((noticeNo) => ({ noticeNo, ord: "000" }));
  }

  // 인자가 없으면 기존 파이프라인의 fetchBidNotices()를 그대로 재사용해서
  // 실제 최근 공고 목록을 가져온다 (PoC3 표본 분포 확보가 진짜 목적).
  const daysIdx = cliArgs.indexOf("--days");
  const daysArg = daysIdx >= 0 ? Number(cliArgs[daysIdx + 1]) : NaN;

  const env = loadEnv();
  const days = Number.isFinite(daysArg) && daysArg > 0 ? Math.min(daysArg, 90) : env.lookbackDays;
  const window = lookbackWindow(new Date(), days);

  console.log(`(인자 없음 → fetchBidNotices로 최근 ${days}일 실제 공고 목록을 가져옵니다)`);
  const results = await fetchBidNotices(env, window);
  const allNotices = results.flatMap((r) => r.notices);
  console.log(`최근 ${days}일 본공고 총 ${allNotices.length}건 조회됨.`);

  const limitIdx = cliArgs.indexOf("--limit");
  const limitArg = limitIdx >= 0 ? Number(cliArgs[limitIdx + 1]) : NaN;

  let notices = allNotices;
  if (Number.isFinite(limitArg) && limitArg > 0) {
    // 물품 공고가 대부분 "없음"으로 쏠려 앞에서부터 자르면 표본이 편향되므로,
    // 업무구분(물품/용역/공사)별로 고르게 나눠 담아 다양한 케이스를 확보한다.
    const byType = new Map<string, typeof allNotices>();
    for (const n of allNotices) {
      const list = byType.get(n.businessType) ?? [];
      list.push(n);
      byType.set(n.businessType, list);
    }
    const perType = Math.max(1, Math.ceil(limitArg / byType.size));
    notices = [...byType.values()].flatMap((list) => list.slice(0, perType)).slice(0, limitArg);
    console.log(
      `--limit ${limitArg} 적용 → 업무구분별로 고르게 뽑아 ${notices.length}건만 g2b.go.kr 상세 API로 조회합니다.`
    );
  } else {
    console.log(`총 ${notices.length}건의 본공고를 대상으로 g2b.go.kr 상세 API를 조회합니다.`);
  }

  return notices.map((n) => ({ noticeNo: n.noticeNo, ord: guessOrd(n.raw), businessType: n.businessType }));
}

function toCsv(results: JointBidResult[]): string {
  const header = ["공고번호", "업무구분", "조회성공", "공동수급협정서_제출및구성방식", "공고명", "실패사유"];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [header.map(escape).join(",")];
  for (const r of results) {
    lines.push(
      [
        r.noticeNo,
        r.businessType ?? "",
        r.ok ? "성공" : "실패",
        r.ok ? (r.jointBidValue ?? "") : "",
        r.ok ? (r.bidPbancNm ?? "") : "",
        r.ok ? "" : (r.reason ?? ""),
      ]
        .map((v) => escape(String(v)))
        .join(",")
    );
  }
  return "﻿" + lines.join("\r\n"); // BOM 포함 → 엑셀에서 한글 깨짐 방지
}

async function main() {
  const targets = await collectTargets(process.argv.slice(2));
  if (targets.length === 0) {
    console.log("조회할 공고가 없습니다.");
    return;
  }

  console.log("세션 쿠키 확보 중...");
  const cookie = await getSessionCookie();

  const results: JointBidResult[] = [];
  for (const { noticeNo, ord, businessType } of targets) {
    const result = await fetchJointBidField(noticeNo, ord, cookie, businessType);
    results.push(result);
    // 서버 부하 방지용 소폭 지연 (대량 조회 시 필수)
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("\n===== 1) 건별 결과 =====");
  for (const r of results) {
    if (r.ok) {
      console.log(`  ${r.noticeNo}: "${r.jointBidValue}"  (${r.bidPbancNm ?? ""})`);
    } else {
      console.log(`  ${r.noticeNo}: 조회 실패 — ${r.reason} (bidPbancOrd="${r.ord}"가 아닐 수 있음)`);
    }
  }

  console.log("\n===== 2) 값 분포 (PoC3 표본 카테고리 확인용) =====");
  const byValue = new Map<string, string[]>();
  for (const r of results) {
    if (!r.ok || r.jointBidValue === undefined) continue;
    const list = byValue.get(r.jointBidValue) ?? [];
    list.push(r.noticeNo);
    byValue.set(r.jointBidValue, list);
  }
  [...byValue.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([value, list]) =>
      console.log(`  "${value}": ${list.length}건 — ${list.slice(0, 20).join(", ")}${list.length > 20 ? " ..." : ""}`)
    );

  const failedCount = results.filter((r) => !r.ok).length;
  if (failedCount > 0) {
    console.log(`\n⚠️  ${failedCount}건 조회 실패 — bidPbancOrd 추정이 틀렸을 가능성이 있습니다 (위 1번 목록 참고).`);
  }

  const outDir = path.join(process.cwd(), "output");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `joint-bid-survey-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  await fs.writeFile(outPath, toCsv(results), "utf-8");
  console.log(`\nCSV 저장 완료 (엑셀에서 바로 열림): ${outPath}`);
}

main().catch((err) => {
  console.error("조사 스크립트 실행 실패:", err);
  process.exitCode = 1;
});
