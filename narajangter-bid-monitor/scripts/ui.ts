import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/config/env.js";
import { loadAppConfig, type AppConfig } from "../src/config/loadJsonConfig.js";
import { fetchJointBidStatus, getSessionCookie } from "../src/api/jointBidApi.js";
import { readQualificationFromNotice, type QualificationDocResult } from "../src/matching/qualificationDoc.js";
import { collectReportInput } from "../src/pipeline.js";
import type { MatchedNotice } from "../src/matching/types.js";
import { classifyBidMethod } from "../src/matching/bidMethod.js";
import { diagnoseNotice, DIAGNOSE_STEPS, type Diagnosis } from "../src/matching/diagnose.js";
import type { CollectionDiagnostics } from "../src/pipeline.js";
import type { NormalizedNotice } from "../src/api/types.js";
import type { PastProject } from "../src/corpus/types.js";
import { SimilarityIndex } from "../src/similarity/index.js";
import { calibrate } from "../src/similarity/calibrate.js";

/**
 * 유사도 탐색기 — 로컬 웹 UI.
 *
 *   npm run ui          → http://localhost:5173
 *
 * **기본은 127.0.0.1에만 바인딩한다.** 코퍼스에는 과업지시서 본문과 발주기관 담당자
 * 성명·연락처가 들어 있어서, 0.0.0.0으로 열면 같은 네트워크의 다른 PC에서 그대로 보인다.
 *
 * `--lan`을 주면 사내망에 연다. 그때는 접근 토큰이 반드시 붙는다(아래 TOKEN 참고) —
 * 이 PC는 방화벽이 꺼져 있어 주소만 알면 누구나 들어올 수 있기 때문이다.
 * 사내망 공유용이며, 인터넷에 노출할 물건은 아니다.
 *
 * 의존성을 더하지 않으려고 node:http만 쓴다 — 화면 하나에 엔드포인트 두 개라
 * 프레임워크를 들일 이유가 없다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(HERE, "ui.html");
const CORPUS_PATH = resolve(process.env.CORPUS_PATH ?? "data/past-projects.json");
const PORT = Number(process.env.UI_PORT ?? 5173);

const argv = process.argv.slice(2);
/** --lan: 사내망의 다른 PC에서도 볼 수 있게 연다. 기본은 이 PC에서만(127.0.0.1). */
const LAN = argv.includes("--lan") || process.env.UI_LAN === "1";
const HOST = LAN ? "0.0.0.0" : "127.0.0.1";

/**
 * 접근 토큰. --lan일 때만 의미가 있다.
 *
 * 이 PC는 방화벽이 꺼져 있어서 0.0.0.0으로 열면 같은 네트워크의 **모든 기기**가 접근할 수 있다.
 * 화면에는 과업지시서 본문과 발주기관 담당자 성명·연락처가 실리므로, 링크를 아는 사람만
 * 들어오도록 최소한의 자물쇠를 건다. 사내망 안에서 쓰는 도구라 계정 체계까지는 과하고,
 * 공유 링크에 붙는 토큰 하나면 충분하다 — 인터넷에 노출할 물건이 아니다.
 */
/**
 * 토큰을 직접 지정하면 로컬 모드에서도 적용한다 — 공유 전에 잠금 동작을 확인해볼 수 있어야 한다.
 * 지정하지 않으면 --lan일 때만 파일에 저장된 토큰을 쓰고, 로컬 전용일 때는 잠그지 않는다.
 */
const EXPLICIT_TOKEN = argFlag("--token") ?? process.env.UI_TOKEN ?? null;
const TOKEN = EXPLICIT_TOKEN ?? (LAN ? persistedToken() : null);

function argFlag(name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

/**
 * 토큰을 파일에 저장해 재시작해도 같은 값을 쓴다.
 *
 * 실행할 때마다 새로 만들면 **팀원에게 보낸 링크가 재시작 때마다 죽는다.** 게다가 팀원
 * 브라우저에는 이전 토큰 쿠키가 남아 있어서, 페이지는 떠 있는데 버튼만 안 먹는 이상한
 * 상태가 된다(실제로 이 버그를 겪었다). 링크는 한 번 보내면 계속 살아 있어야 한다.
 */
function persistedToken(): string {
  const file = resolve("cache/ui-token");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (saved.length >= 8) return saved;
  } catch {
    /* 없으면 새로 만든다 */
  }
  const token = randomBytes(9).toString("base64url");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, token, "utf8");
  } catch {
    /* 저장 못 해도 이번 실행에는 쓴다 */
  }
  return token;
}

/** 첫 번째 사설 IPv4 주소 (공유 링크 안내용) */
function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "localhost";
}

let projects: PastProject[];
try {
  projects = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as PastProject[];
} catch {
  console.error(`코퍼스를 읽지 못했습니다: ${CORPUS_PATH}`);
  console.error("먼저 실행하세요:  npm run build:corpus -- <아카이브 폴더 경로>");
  process.exit(1);
}

// 인덱스는 시작할 때 한 번만 만든다. 103건이면 수십 ms라 요청마다 만들어도 되지만,
// 코퍼스가 커져도 같은 코드가 버티도록 여기서 잡아둔다.
const index = SimilarityIndex.build(projects);
const byId = new Map(projects.map((p) => [p.id, p]));

const stats = {
  total: projects.length,
  withBody: projects.filter((p) => p.body.length > 0).length,
  withBudget: projects.filter((p) => p.budgetAmount != null).length,
  years: summarizeYears(projects),
  range: `${Math.min(...projects.map((p) => p.year))}–${Math.max(...projects.map((p) => p.year))}`,
};

function summarizeYears(list: PastProject[]): string {
  const counts = new Map<number, number>();
  for (const p of list) counts.set(p.year, (counts.get(p.year) ?? 0) + 1);
  return [...counts].sort().map(([y, c]) => `${y}년 ${c}건`).join(" · ");
}

function json(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

/**
 * 실제 나라장터 공고 조회 결과 캐시.
 *
 * 조회에 40초쯤 걸리므로(본공고 3종 + 사전규격 3종 + 면허제한정보) 화면을 새로 열 때마다
 * 다시 부르면 쓸 수가 없다. 한 번 불러두고 명시적으로 새로고침할 때만 다시 조회한다.
 */
interface NoticeCache {
  fetchedAt: Date;
  lookbackDays: number;
  items: unknown[];
  error: string | null;
}
let noticeCache: NoticeCache | null = null;
/**
 * 마지막 조회에서 받은 공고 전체와 판정 맥락. noticeCache와 따로 둔다 — noticeCache는 그대로
 * JSON으로 내려보내는데, 여기에는 공고 수만 건의 원본이 들어 있어 섞이면 응답이 수십 MB가 된다.
 */
let lastDiagnostics: CollectionDiagnostics | null = null;
/** 제외된 후보 목록 계산 결과 (같은 조회에 대해서는 한 번만 계산) */
let excludedCache: { source: CollectionDiagnostics; items: unknown[]; byStage: Record<string, number> } | null = null;
let inFlight: Promise<NoticeCache> | null = null;

/** 어떤 규칙이 이 공고를 걸었는지 한 줄로 (feedbackRow.ts의 표기와 같은 형식) */
function matchReason(m: MatchedNotice): string {
  const parts = [
    ...m.matchedProductCodes.map((c) => `품목 ${c.name}`),
    ...m.matchedIndustryCodes.map((c) => `업종 ${c.name}`),
    ...m.matchedKeywords.map((k) => `키워드 ${k}`),
  ];
  return parts.length > 0 ? parts.join(" / ") : "(근거 없음)";
}

function decorate(m: MatchedNotice): unknown {
  const n = m.notice;
  // 여기가 ④단계를 실제로 붙여보는 자리다. 파이프라인 본체는 아직 건드리지 않았고,
  // 이 화면에서만 규칙 매칭 결과 위에 유사도를 얹어 눈으로 비교한다.
  const similarity = index.findSimilar(n.title, 3);
  return {
    noticeNo: n.noticeNo,
    title: n.title,
    institution: n.institution,
    businessType: n.businessType,
    sourceType: n.sourceType,
    deadline: n.deadline,
    budgetAmount: n.budgetAmount,
    detailUrl: n.detailUrl,
    bidMethod: n.bidMethod,
    bidMethodCategory: classifyBidMethod(n.bidMethod),
    confidence: m.confidence,
    reason: matchReason(m),
    overseas: m.overseasVenueFlag?.matchedMongoliaKeyword ?? null,
    qualification: m.qualification ?? null,
    maxScore: calibrate(similarity.maxScore, similarity.basis),
    rawScore: similarity.maxScore,
    basis: similarity.basis,
    similar: similarity.top.map((s) => ({ id: s.id, name: s.name, year: s.year, score: s.score })),
  };
}

function noticeSummary(n: NormalizedNotice, d: Diagnosis): unknown {
  const failed = d.steps.find((s) => s.step === d.excludedAt);
  return {
    noticeNo: n.noticeNo,
    title: n.title,
    institution: n.institution,
    businessType: n.businessType,
    sourceType: n.sourceType,
    deadline: n.deadline,
    budgetAmount: n.budgetAmount,
    detailUrl: n.detailUrl,
    bidMethod: n.bidMethod,
    excludedAt: d.excludedAt,
    excludedDetail: failed?.detail ?? null,
    candidate: d.candidate,
    steps: d.steps,
  };
}

/**
 * 키워드·품목으로는 걸렸는데(= 우리 공고 후보) 다른 조건으로 빠진 공고.
 * 키워드·품목 단계에서 떨어진 공고는 싣지 않는다 — 수만 건이라 목록으로는 쓸모가 없고,
 * 그런 공고는 공고번호 추적으로 한 건씩 본다.
 */
function excludedCandidates(diag: CollectionDiagnostics): { items: unknown[]; byStage: Record<string, number> } {
  if (excludedCache?.source === diag) return excludedCache;
  const byStage: Record<string, number> = Object.fromEntries(DIAGNOSE_STEPS.map((s) => [s, 0]));
  const items: unknown[] = [];
  for (const n of diag.notices) {
    const d = diagnoseNotice(n, diag.context);
    if (!d.candidate || d.excludedAt === null) continue;
    byStage[d.excludedAt] = (byStage[d.excludedAt] ?? 0) + 1;
    items.push(noticeSummary(n, d));
  }
  excludedCache = { source: diag, items, byStage };
  return excludedCache;
}

// ── 담당자 판정 (② 수집 정제 · ③ 미수집 원인) ─────────────────────────
/**
 * 판정은 이 PC의 cache/verdicts.json에 쌓는다. 공고번호당 마지막 판정 하나만 남긴다.
 * 구글 피드백 시트는 "수집된" 공고만 담는데, 여기서는 제외된 공고·추적한 공고도 판정해야 해서
 * 따로 둔다. CSV로 내려받아 시트에 붙일 수 있다.
 */
const VERDICTS_PATH = resolve("cache/verdicts.json");
interface Verdict {
  noticeNo: string;
  title: string;
  verdict: "적절" | "부적절";
  note: string;
  by: string;
  at: string;
  /** 판정할 때 시스템이 이 공고를 어떻게 처리했는지 */
  systemResult: string;
}
function loadVerdicts(): Record<string, Verdict> {
  try {
    return JSON.parse(readFileSync(VERDICTS_PATH, "utf8")) as Record<string, Verdict>;
  } catch {
    return {};
  }
}
let verdicts = loadVerdicts();
function saveVerdicts(): void {
  mkdirSync(dirname(VERDICTS_PATH), { recursive: true });
  writeFileSync(VERDICTS_PATH, JSON.stringify(verdicts, null, 2), "utf8");
}

// ── 참가여부 (담당자끼리 공유) ─────────────────────────────────
/**
 * 공고마다 참가여부·담당자·대화를 cache/participation.json에 둔다. 같은 링크로 들어온
 * 사람 모두가 같은 기록을 본다 — "A가 이미 보고 있다", "보류인데 왜?"를 바로 알 수 있게.
 * 상태를 바꾸면 대화에 시스템 기록을 한 줄 남긴다. 나중에 보는 사람이 경위를 따라갈 수 있어야 한다.
 */
const PARTICIPATION_STATUSES = ["검토중", "참가", "보류", "불참"] as const;
type ParticipationStatus = (typeof PARTICIPATION_STATUSES)[number];
interface Participation {
  noticeNo: string;
  title: string;
  status: ParticipationStatus | null;
  owner: string;
  updatedAt: string;
  comments: { by: string; text: string; at: string; system?: boolean }[];
}
const PARTICIPATION_PATH = resolve("cache/participation.json");
let participation: Record<string, Participation> = (() => {
  try {
    return JSON.parse(readFileSync(PARTICIPATION_PATH, "utf8")) as Record<string, Participation>;
  } catch {
    return {};
  }
})();
function saveParticipation(): void {
  mkdirSync(dirname(PARTICIPATION_PATH), { recursive: true });
  writeFileSync(PARTICIPATION_PATH, JSON.stringify(participation, null, 2), "utf8");
}

// ── 부가 정보 (공고문 참가자격 · 공동수급) ──────────────────────
/**
 * 공고 목록을 먼저 보여주고 뒤에서 채운다. 공고문 다운로드·추출과 g2b 공동수급 조회는 건당
 * 수백 ms~수 초라, 목록 응답을 붙잡아 두면 화면이 그만큼 늦게 뜬다. 화면은 /api/enrich를
 * 주기적으로 불러 채워진 만큼 배지를 갱신한다.
 *
 * 결과는 공고번호로 프로세스가 떠 있는 동안 계속 쓴다 — 공고문과 공동수급 방식은 공고 후
 * 잘 바뀌지 않고, 정정공고는 첨부 URL이 바뀌어 첨부 캐시가 알아서 새로 받는다.
 */
interface Enrichment {
  jointBid?: string | null;
  qualDoc?: QualificationDocResult | null;
}
const enrichment = new Map<string, Enrichment>();
let enrichState = { running: false, done: 0, total: 0 };

function startEnrichment(notices: NormalizedNotice[], appConfig: AppConfig): void {
  const todo = notices.filter((n) => {
    const e = enrichment.get(n.noticeNo);
    return !e || e.jointBid === undefined || e.qualDoc === undefined;
  });
  if (enrichState.running || todo.length === 0) return;
  enrichState = { running: true, done: 0, total: todo.length };
  const held = { products: appConfig.heldProducts, industries: appConfig.heldIndustries };

  void (async () => {
    const cookie = await getSessionCookie();
    for (const n of todo) {
      const e = enrichment.get(n.noticeNo) ?? {};
      if (e.jointBid === undefined) e.jointBid = await fetchJointBidStatus(n, cookie).catch(() => null);
      if (e.qualDoc === undefined) e.qualDoc = await readQualificationFromNotice(n, held).catch(() => null);
      enrichment.set(n.noticeNo, e);
      enrichState.done += 1;
      await new Promise((r) => setTimeout(r, 300)); // g2b·조달청 서버에 몰아서 요청하지 않는다
    }
    enrichState.running = false;
  })();
}

function readBody(req: IncomingMessage, limit = 16_000): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > limit) {
        reject(new Error("요청이 너무 큽니다"));
        req.destroy();
      }
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function fetchNotices(lookbackDays: number): Promise<NoticeCache> {
  try {
    const env = loadEnv();
    const appConfig = loadAppConfig();
    const input = await collectReportInput(env, appConfig, { lookbackDays, withDiagnostics: true });
    lastDiagnostics = input.diagnostics ?? null;
    startEnrichment(input.bid.matches.map((m) => m.notice), appConfig);
    const all = [...input.bid.matches, ...input.preStandard.matches];
    // 유사도 높은 순. 기존 리포트는 추천등급→마감일 순인데, 여기서는 ④가 무엇을
    // 끌어올리는지 보는 게 목적이라 일부러 유사도로 세운다.
    const items = all.map(decorate).sort((a, b) => (b as { maxScore: number }).maxScore - (a as { maxScore: number }).maxScore);
    return { fetchedAt: new Date(), lookbackDays, items, error: null };
  } catch (err) {
    return { fetchedAt: new Date(), lookbackDays, items: [], error: String(err) };
  }
}

/**
 * 토큰 확인. 쿠키에 한 번 심어두면 그 뒤로는 링크에 토큰이 없어도 통과한다 —
 * 팀원이 페이지 안에서 탭을 옮기거나 새로고침할 때마다 토큰을 다시 붙일 수는 없기 때문이다.
 */
function authorized(req: IncomingMessage, url: URL, res: ServerResponse): boolean {
  if (!TOKEN) return true;

  if (url.searchParams.get("t") === TOKEN) {
    // HttpOnly: 페이지 스크립트가 토큰을 읽을 이유가 없다. SameSite=Lax: 외부 사이트가
    // 이 서버로 요청을 걸어도 쿠키가 따라가지 않게 한다.
    res.setHeader("set-cookie", `ui_token=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    return true;
  }

  const cookie = req.headers.cookie ?? "";
  return cookie.split(";").some((part) => part.trim() === `ui_token=${TOKEN}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (!authorized(req, url, res)) {
    // **API 요청에는 HTML을 돌려주면 안 된다.** 프론트가 res.json()으로 읽다가
    // "Unexpected token '<', \"<!doctype\"... is not valid JSON"으로 터지고,
    // 사용자에게는 원인과 아무 상관 없는 메시지가 보인다. 실제로 그 버그를 겪었다.
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "접근 토큰이 만료되었거나 올바르지 않습니다. 담당자에게 받은 주소(?t=... 포함)로 다시 여세요.", unauthorized: true }));
      return;
    }
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>접근 제한</title>` +
        `<body style="font:15px/1.6 -apple-system,'Malgun Gothic',sans-serif;padding:40px;max-width:520px;margin:0 auto">` +
        `<h1 style="font-size:18px">접근 권한이 없습니다</h1>` +
        `<p>이 도구는 (주)지일 내부용입니다. 담당자에게 받은 <b>전체 주소(토큰 포함)</b>로 접속하세요.</p>` +
        `<p style="color:#666;font-size:13px">주소 끝에 <code>?t=…</code> 부분이 빠지면 이 화면이 나옵니다.</p></body>`
    );
    return;
  }

  if (url.pathname === "/") {
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(HTML_PATH, "utf8"));
    } catch {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`화면 파일을 찾지 못했습니다: ${HTML_PATH}`);
    }
    return;
  }

  if (url.pathname === "/api/corpus") {
    // 목록에는 본문을 실어 보내지 않는다 — 1.8MB를 매번 넘길 이유가 없고,
    // 본문은 검색 결과에서 발췌로만 보여준다.
    json(res, {
      ...stats,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        year: p.year,
        budgetAmount: p.budgetAmount,
        hasBody: p.body.length > 0,
        bodyLength: p.body.length,
      })),
    });
    return;
  }

  if (url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) {
      json(res, { maxScore: 0, top: [] });
      return;
    }
    const result = index.findSimilar(q, 10);
    json(res, {
      maxScore: calibrate(result.maxScore, result.basis),
      rawScore: result.maxScore,
      basis: result.basis,
      top: result.top.map((m) => {
        const project = byId.get(m.id);
        return {
          ...m,
          budgetAmount: project?.budgetAmount ?? null,
          // 발췌는 앞 600자만. 전체 본문을 브라우저로 넘기면 화면이 무거워지고,
          // 사람이 "이 사업이 맞나" 확인하는 데는 과업개요만 있으면 된다.
          excerpt: project && project.body.length > 0 ? project.body.slice(0, 600) : null,
        };
      }),
    });
    return;
  }

  // 정적 자산 (로고). 경로에 /나 ..가 끼어들지 못하게 파일명만 받는다 —
  // 이 서버는 127.0.0.1 전용이지만 경로 탈출은 습관적으로 막아둔다.
  if (url.pathname.startsWith("/assets/")) {
    const name = url.pathname.slice("/assets/".length);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
      res.writeHead(400).end("bad asset name");
      return;
    }
    try {
      const body = readFileSync(resolve(HERE, "assets", name));
      const type = name.endsWith(".png") ? "image/png" : name.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "max-age=3600" });
      res.end(body);
    } catch {
      res.writeHead(404).end("asset not found");
    }
    return;
  }

  if (url.pathname === "/api/explain") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const id = url.searchParams.get("id") ?? "";
    const explanation = q && id ? index.explain(q, id) : null;
    if (!explanation) {
      json(res, { error: "설명할 수 없습니다 (질의 또는 사업 ID 없음)" });
      return;
    }
    // n-gram 목록이 수백 개까지 가므로 상위 기여분만 보낸다 — 나머지는 합계에만 영향을 준다.
    json(res, {
      ...explanation,
      nameTerms: explanation.nameTerms.slice(0, 12),
      nameTermCount: explanation.nameTerms.length,
      missingFromName: explanation.missingFromName.slice(0, 12),
      bodyTerms: explanation.bodyTerms?.slice(0, 10) ?? null,
      bodyTermCount: explanation.bodyTerms?.length ?? 0,
    });
    return;
  }

  if (url.pathname === "/api/excluded") {
    if (!lastDiagnostics) {
      json(res, { error: "먼저 '실제 공고' 탭에서 나라장터 공고를 불러오세요." });
      return;
    }
    const { items, byStage } = excludedCandidates(lastDiagnostics);
    json(res, { lookbackDays: noticeCache?.lookbackDays ?? null, fetchedAt: noticeCache?.fetchedAt ?? null, total: lastDiagnostics.notices.length, byStage, items });
    return;
  }

  if (url.pathname === "/api/trace") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!lastDiagnostics) {
      json(res, { error: "먼저 '실제 공고' 탭에서 나라장터 공고를 불러오세요." });
      return;
    }
    if (q.length < 2) {
      json(res, { error: "공고번호나 제목 일부를 2자 이상 입력하세요." });
      return;
    }
    // 공고번호(영문·숫자·하이픈)는 앞부분 일치, 그 밖에는 제목 부분일치(공백 무시).
    const byNo = /^[A-Za-z0-9-]+$/.test(q);
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const needle = norm(q);
    const found = lastDiagnostics.notices
      .filter((n) => (byNo ? n.noticeNo.toLowerCase().startsWith(needle) : norm(n.title).includes(needle)))
      .slice(0, 30);
    json(res, {
      lookbackDays: noticeCache?.lookbackDays ?? null,
      total: lastDiagnostics.notices.length,
      items: found.map((n) => noticeSummary(n, diagnoseNotice(n, lastDiagnostics!.context))),
    });
    return;
  }

  if (url.pathname === "/api/enrich") {
    json(res, { ...enrichState, byNo: Object.fromEntries(enrichment) });
    return;
  }

  if (url.pathname === "/api/participation" && req.method === "GET") {
    json(res, { participation, statuses: PARTICIPATION_STATUSES });
    return;
  }

  if (url.pathname === "/api/participation" && req.method === "POST") {
    if (!(req.headers["content-type"] ?? "").includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "application/json만 받습니다." }));
      return;
    }
    readBody(req)
      .then((raw) => {
        const b = JSON.parse(raw) as { noticeNo?: string; title?: string; by?: string; status?: string; owner?: string; comment?: string };
        const noticeNo = String(b.noticeNo ?? "").trim();
        const by = String(b.by ?? "").trim().slice(0, 40);
        if (!noticeNo) throw new Error("공고번호가 없습니다");
        if (!by) throw new Error("이름을 먼저 입력하세요");
        const now = new Date().toISOString();
        const p: Participation = participation[noticeNo] ?? {
          noticeNo,
          title: String(b.title ?? "").slice(0, 300),
          status: null,
          owner: "",
          updatedAt: now,
          comments: [],
        };
        const log = (text: string) => p.comments.push({ by, text, at: now, system: true });

        if (b.status !== undefined) {
          const status = b.status === "" ? null : (b.status as ParticipationStatus);
          if (status !== null && !PARTICIPATION_STATUSES.includes(status)) throw new Error("알 수 없는 상태입니다");
          if (status !== p.status) {
            log(status ? `상태를 '${status}'(으)로 변경` : "상태를 지움");
            p.status = status;
          }
          // 처음 상태를 정한 사람이 담당자가 된다 (따로 지정하지 않았다면)
          if (status && !p.owner) {
            p.owner = by;
            log(`담당자: ${by}`);
          }
        }
        if (b.owner !== undefined) {
          const owner = String(b.owner).trim().slice(0, 40);
          if (owner !== p.owner) {
            log(owner ? `담당자를 '${owner}'(으)로 지정` : "담당자를 비움");
            p.owner = owner;
          }
        }
        const comment = String(b.comment ?? "").trim().slice(0, 1000);
        if (comment) p.comments.push({ by, text: comment, at: now });

        p.updatedAt = now;
        participation[noticeNo] = p;
        saveParticipation();
        json(res, { ok: true, participation: p });
      })
      .catch((err: unknown) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      });
    return;
  }

  if (url.pathname === "/api/verdicts" && req.method === "GET") {
    json(res, { verdicts });
    return;
  }

  if (url.pathname === "/api/verdicts.csv") {
    const head = ["공고번호", "공고명", "판정", "메모", "판정자", "판정일시", "시스템 처리"];
    const rows = Object.values(verdicts).map((v) =>
      [v.noticeNo, v.title, v.verdict, v.note, v.by, v.at, v.systemResult].map((c) => csvCell(String(c ?? ""))).join(",")
    );
    // 엑셀이 UTF-8 CSV를 한글 깨짐 없이 열도록 BOM을 붙인다.
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="verdicts.csv"`,
    });
    res.end("\uFEFF" + [head.join(","), ...rows].join("\r\n"));
    return;
  }

  if (url.pathname === "/api/verdict" && req.method === "POST") {
    // application/json만 받는다 — 다른 사이트의 폼이 이 서버로 몰래 POST하는 것을 막는다
    // (JSON 요청은 브라우저가 사전 확인을 거치므로 다른 출처에서는 막힌다).
    if (!(req.headers["content-type"] ?? "").includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "application/json만 받습니다." }));
      return;
    }
    readBody(req)
      .then((raw) => {
        const b = JSON.parse(raw) as Partial<Verdict> & { clear?: boolean };
        const noticeNo = String(b.noticeNo ?? "").trim();
        if (!noticeNo) throw new Error("공고번호가 없습니다");
        if (b.clear) {
          delete verdicts[noticeNo];
        } else {
          if (b.verdict !== "적절" && b.verdict !== "부적절") throw new Error("판정은 적절/부적절 중 하나여야 합니다");
          verdicts[noticeNo] = {
            noticeNo,
            title: String(b.title ?? "").slice(0, 300),
            verdict: b.verdict,
            note: String(b.note ?? "").slice(0, 500),
            by: String(b.by ?? "").slice(0, 40),
            at: new Date().toISOString(),
            systemResult: String(b.systemResult ?? "").slice(0, 200),
          };
        }
        saveVerdicts();
        json(res, { ok: true, verdict: verdicts[noticeNo] ?? null });
      })
      .catch((err: unknown) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      });
    return;
  }

  if (url.pathname === "/api/notices") {
    const days = Number(url.searchParams.get("days") ?? 7);
    const refresh = url.searchParams.get("refresh") === "1";

    if (!refresh && noticeCache && noticeCache.lookbackDays === days) {
      json(res, { ...noticeCache, cached: true });
      return;
    }

    // 조회가 도는 중에 새로고침을 또 누르면 같은 약속을 돌려준다 —
    // API를 두 번 때리면 느려질 뿐 아니라 일일 호출 한도를 두 배로 쓴다.
    if (!inFlight) {
      inFlight = fetchNotices(days).then((result) => {
        noticeCache = result;
        inFlight = null;
        return result;
      });
    }
    inFlight
      .then((result) => json(res, { ...result, cached: false }))
      .catch((err: unknown) => {
        inFlight = null;
        json(res, { fetchedAt: new Date(), lookbackDays: days, items: [], error: String(err), cached: false });
      });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`\n유사도 탐색기 — 코퍼스 ${stats.total}건 (본문 ${stats.withBody}건)`);
  if (!LAN) {
    console.log(`\n  http://localhost:${PORT}`);
    console.log(`\n  이 PC에서만 열립니다. 팀원과 공유하려면:  npm run ui -- --lan`);
  } else {
    const share = `http://${lanAddress()}:${PORT}/?t=${TOKEN}`;
    console.log(`\n  팀원에게 보낼 주소 (이 줄 전체를 복사하세요)`);
    console.log(`  ${share}`);
    console.log(`\n  · 같은 사내망에 있는 기기만 접속할 수 있습니다.`);
    console.log(`  · 이 PC가 켜져 있고 이 창이 떠 있는 동안만 동작합니다.`);
    console.log(`  · 화면에 과업지시서 본문과 발주기관 담당자 연락처가 나옵니다.`);
    console.log(`    사내 공유용이며, 외부로 주소를 전달하지 마세요.`);
  }
  console.log(`\n  종료: Ctrl+C\n`);
});
