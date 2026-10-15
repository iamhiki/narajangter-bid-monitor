import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/config/env.js";
import { loadAppConfig, type AppConfig } from "../src/config/loadJsonConfig.js";
import { fetchJointBidStatus, getSessionCookie } from "../src/api/jointBidApi.js";
import { meetsRegion, readQualificationFromNotice, type QualificationDocResult } from "../src/matching/qualificationDoc.js";
import { loadHeadquartersRegion } from "../src/matching/regionFilter.js";
import { fetchNoticeBody, fetchNoticeOutline } from "../src/api/noticeBody.js";
import type { ScopeFlag } from "../src/matching/taskScopeFlags.js";
import { announceName } from "../src/net/mdns.js";
import { findCoreWords, findMakeEvidence, MAKE_EVIDENCE_MIN } from "../src/matching/coreWork.js";
import { findSubmissionDeadline, type SubmissionDeadline } from "../src/matching/submissionDeadline.js";
import { mainWorkOf } from "../src/matching/mainWork.js";
import { taskExcerpt } from "../src/corpus/taskExcerpt.js";
import { lookupProductClass, type ProductClassInfo } from "../src/api/productClassApi.js";
import { collectReportInput } from "../src/pipeline.js";
import type { MatchedNotice } from "../src/matching/types.js";
import { classifyBidMethod } from "../src/matching/bidMethod.js";
import { matchKeywords } from "../src/matching/keywordMatcher.js";
import { parseKstDateTime } from "../src/matching/deadline.js";
import { diagnoseNotice, DIAGNOSE_STEPS, type Diagnosis } from "../src/matching/diagnose.js";
import type { CollectionDiagnostics } from "../src/pipeline.js";
import type { NormalizedNotice } from "../src/api/types.js";
import type { PastProject } from "../src/corpus/types.js";
import { buildSimilarityIndex } from "../src/similarity/loadCorpus.js";
import { calibrate } from "../src/similarity/calibrate.js";
import { groupWorkTerms } from "../src/similarity/workTerms.js";

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

/**
 * --lan일 때 사내망에 알릴 이름 — 팀원은 http://jiil-bid.local 로 들어온다 (src/net/mdns.ts).
 * IP는 DHCP로 바뀔 수 있어 이름으로 안내한다. UI_HOSTNAME으로 바꿀 수 있고, 빈 값이면 알리지 않는다.
 */
const HOSTNAME = (process.env.UI_HOSTNAME ?? "jiil-bid").trim();

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
const index = buildSimilarityIndex(projects);
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
  /** 화면의 기간 선택값 그대로 ("7", "30", "open" …) — 같은 선택이면 캐시를 쓴다 */
  period: string;
  /** 화면에 찍을 기간 이름 ("최근 7일", "마감 전 공고 전체") */
  periodLabel: string;
  items: unknown[];
  /** 마감 지난 본공고 중 조건에 맞는 것 — 화면 맨 아래 "마감된 공고" 칸 (최근 마감 순) */
  closedItems: unknown[];
  /** 제목의 제외 키워드로만 빠진 후보 — 첨부를 읽어 본업 근거가 나온 것만 화면에 보인다 (rescue) */
  titleExcludedItems: unknown[];
  /** 보유 세부품명과 일치하지만 목록에 없던 공고 — 화면 '보유 품목 공고' 칸 */
  heldItems?: unknown[];
  /** 보유 세부품명 목록 (held-qualifications.json — 읽기만) */
  heldProducts?: { code: string; name: string }[];
  /** 이번 조회에서 나라장터로부터 받은 공고 수 (걸러내기 전) — 화면 조회 정보 줄 */
  collected?: { bid: number; pre: number };
  error: string | null;
}

/**
 * "마감 전 공고 전체"로 볼 때 본공고를 거슬러 올라가는 기간.
 * 나라장터 API는 게시일로만 조회되고 마감일로는 조회할 수 없어서, 넉넉히 받아 마감 지난 것을 뺀다.
 * 2026-09-30 실측(90일치 본공고): 마감 전 7,457건 중 게시 60일 넘은 건 25건(0.3%),
 * 우리 키워드에 걸린 32건은 모두 게시 30일 이내였다.
 */
const OPEN_BID_LOOKBACK_DAYS = 60;

/**
 * 기간 선택값 → 조회 기간. 사전규격은 입찰 마감이 없어 "마감 전 전체"에서도 최근 7일만 본다.
 * "마감 전 전체"는 받아둔 공고에 새로 올라온 것만 이어 받는다 — 그날 첫 조회만 3~4분 걸리고,
 * 그 뒤로는 추가분만 받는다 (api/incrementalFetch.ts).
 */
function periodOptions(period: string): {
  lookbackDays: number;
  preStandardLookbackDays?: number;
  incremental?: boolean;
  label: string;
} {
  if (period === "open") {
    return {
      lookbackDays: OPEN_BID_LOOKBACK_DAYS,
      preStandardLookbackDays: 7,
      incremental: true,
      label: "마감 전 공고 전체",
    };
  }
  const days = Number(period);
  const lookbackDays = Number.isInteger(days) && days >= 1 && days <= 90 ? days : 7;
  return { lookbackDays, label: `최근 ${lookbackDays}일` };
}
let noticeCache: NoticeCache | null = null;
/**
 * 마지막 조회에서 받은 공고 전체와 판정 맥락. noticeCache와 따로 둔다 — noticeCache는 그대로
 * JSON으로 내려보내는데, 여기에는 공고 수만 건의 원본이 들어 있어 섞이면 응답이 수십 MB가 된다.
 */
let lastDiagnostics: CollectionDiagnostics | null = null;
/** 제외된 후보 목록 계산 결과 (같은 조회에 대해서는 한 번만 계산) */
let excludedCache: { source: CollectionDiagnostics; items: unknown[]; byStage: Record<string, number> } | null = null;
/** 기간별로 진행 중인 조회. 한 개만 두면 14일 조회 중에 "마감 전 전체"를 눌러도 14일 결과가 돌아왔다(2026-10-01) */
const inFlight = new Map<string, Promise<NoticeCache>>();

/** 어떤 규칙이 이 공고를 걸었는지 한 줄로 (feedbackRow.ts의 표기와 같은 형식) */
function matchReason(m: MatchedNotice): string {
  const parts = [
    ...m.matchedProductCodes.map((c) => `품목 ${c.name}`),
    ...m.matchedIndustryCodes.map((c) => `업종 ${c.name}`),
    ...m.matchedKeywords.map((k) => `키워드 ${k}`),
    ...(m.matchedServiceClasses ?? []).map((c) => `분류 ${c.name}`),
  ];
  return parts.length > 0 ? parts.join(" / ") : "(근거 없음)";
}

/**
 * 수요기관 — 실제로 사업을 발주한 곳. 입찰공고의 institution은 공고기관(ntceInsttNm)이라
 * 조달청 대행 공고는 전부 "조달청"으로 나온다. 담당자가 알고 싶은 건 수요기관이다.
 * 입찰공고 dminsttNm, 사전규격 rlDminsttNm(실수요기관).
 */
/**
 * 본공고인데 입찰마감(bidClseDt)이 비어 개찰일시(opengDt)를 마감으로 쓴 공고 (fieldCandidates deadline 후보 순서).
 * 협상에의한계약 공고에 많다 — 2026-10-02 본공고 6.8만 건 중 5,143건. 실제 제출 마감은 개찰보다 앞일 수 있어
 * 화면에 "입찰 마감"이 아니라 "개찰"로 밝힌다.
 */
function deadlineIsOpening(n: NormalizedNotice): boolean {
  const raw = (n.raw ?? {}) as Record<string, unknown>;
  return n.sourceType === "본공고" && !!n.deadline && !String(raw.bidClseDt ?? raw.bidClseDate ?? "").trim();
}

/**
 * 입찰참가자격 등록 마감 (본공고 bidQlfctRgstDt, 예: "2026-10-28 18:00"). 보통 입찰 마감 하루 전이라
 * 화면의 마감 임박 정렬·D-day는 이 값과 입찰 마감 중 이른 쪽을 기준으로 한다 (2026-10-14 요청). 없으면 null.
 */
function registrationDeadlineOf(n: NormalizedNotice): string | null {
  if (n.sourceType !== "본공고") return null;
  const v = (n.raw ?? {})["bidQlfctRgstDt"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function demandInstitutionOf(n: NormalizedNotice): string | null {
  const raw = (n.raw ?? {}) as Record<string, unknown>;
  for (const key of ["dminsttNm", "rlDminsttNm", "dmndInsttNm"]) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

interface SimilarityView {
  maxScore: number;
  rawScore: number;
  basis: string;
  /**
   * 근거 키워드를 찾은 공고 쪽 글 — 과업지시서(또는 연결 사전규격 제안요청서)를 읽었으면 "과업지시서",
   * 과업지시서가 없어 입찰공고문 개요·공내역서로 찾았으면 "공고문·내역서", 제목만이면 null.
   */
  textSource: "과업지시서" | "공고문·내역서" | null;
  /**
   * 싱크로율 근거 — 화면에서 % 숫자를 눌러야 보인다(개발·검수용). 과거사업마다 원점수·표시값,
   * 사업명 점수·본문 점수, 사업명끼리 겹친 조각 수, 실제로 겹친 말.
   */
  similar: {
    id: string;
    name: string;
    year: number;
    score: number;
    shown: number;
    nameScore: number;
    bodyScore: number | null;
    sharedNameTokens: number;
    /** 실적 키워드 점수 (0~1) — 원점수의 80%가 이 값이다 (similarity/keywordScore.ts) */
    keywordScore: number | null;
    /**
     * 실적 키워드 — 점수에 들어간, 공고(제목+과업 글)와 이 과거 실적(사업명+과업지시서)에 함께 나온 일의 종류를
     * 뜻하는 말 (similarity/workTerms.ts). 일의 내용 → 시설 이름 순. 지역·기관명은 나오지 않는다.
     */
    keywords: string[];
    /** 이 과거 사업의 꼬리표 — 공고와 겹치는 키워드(shared) 먼저, 그다음 이 사업에만 있는 키워드를 묶음 순서로 */
    tags: { term: string; shared: boolean }[];
    /** 꼬리표 칸이 넘쳐 보이지 않는 이 사업의 키워드 수 */
    moreTags: number;
  }[];
  /** 이 공고의 과업 프로필 — 공고 글에 나온 실적 키워드를 묶음별로 (workTerms.ts) */
  profile: { name: string; terms: string[] }[];
}

/** 과거 사업 꼬리표 최대 개수. 겹치는 키워드는 이보다 많아도 다 보이고, 이 사업에만 있는 키워드는 남은 칸까지만 */
const MAX_TAGS = 12;

/** 과거 사업 꼬리표 — 겹치는 키워드(점수 기여 순) 다음에 이 사업에만 있는 키워드(묶음 순) */
function projectTags(shared: string[], projectTerms: string[]): { tags: { term: string; shared: boolean }[]; moreTags: number } {
  const sharedSet = new Set(shared);
  const rest = groupWorkTerms(projectTerms.filter((t) => !sharedSet.has(t))).flatMap((g) => g.terms);
  const room = Math.max(0, MAX_TAGS - shared.length);
  return {
    tags: [...shared.map((term) => ({ term, shared: true })), ...rest.slice(0, room).map((term) => ({ term, shared: false }))],
    moreTags: Math.max(0, rest.length - room),
  };
}

/**
 * 싱크로율. 과업지시서·제안요청서 본문을 읽었으면 그 본문으로, 아니면 제목으로 과거사업과 비교한다.
 * outline(공고문 개요·공내역서)은 기준을 바꾸지 않고 실적 키워드 점수에만 보탠다 (index.ts의 keywordText).
 */
function similarityView(title: string, body?: { text: string; fullText: string }, outline?: string): SimilarityView {
  // 글자 비교는 앞 12,000자, 실적 키워드는 문서 전체(과업지시서) 또는 공고문·내역서 개요로 센다
  const s = index.findSimilar(title, 3, body ? { body: body.text, keywordText: body.fullText } : outline ? { keywordText: outline } : {});
  return {
    maxScore: calibrate(s.maxScore, s.basis),
    rawScore: s.maxScore,
    basis: s.basis,
    textSource: body ? "과업지시서" : outline ? "공고문·내역서" : null,
    similar: s.top.map((t) => ({
      id: t.id,
      name: t.name,
      year: t.year,
      score: t.score,
      shown: calibrate(t.score, s.basis),
      nameScore: t.nameScore,
      bodyScore: t.bodyScore,
      sharedNameTokens: t.sharedNameTokens,
      keywordScore: t.keywordScore,
      // 화면 근거 = 점수에 들어간 키워드 그대로
      keywords: t.keywords,
      ...projectTags(t.keywords, t.projectTerms),
    })),
    profile: groupWorkTerms(s.queryTerms),
  };
}

/** 제목 키워드·품목 없이 조달분류만으로 들어온 공고 — 첨부 과업으로 본업인지 다시 확인한다 */
function isClassOnly(m: MatchedNotice): boolean {
  return (m.matchedServiceClasses?.length ?? 0) > 0 && m.matchedKeywords.length === 0 && m.matchedProductCodes.length === 0;
}

function decorate(m: MatchedNotice, appConfig: AppConfig): unknown {
  const n = m.notice;
  // 첨부 본문 기준 값은 뒤에서 채운다(startEnrichment). 이미 읽어둔 공고면 처음부터 그 값을 쓴다.
  const similarity = enrichment.get(n.noticeNo)?.similarity ?? similarityView(n.title);
  return {
    noticeNo: n.noticeNo,
    title: n.title,
    institution: n.institution,
    demandInstitution: demandInstitutionOf(n),
    businessType: n.businessType,
    sourceType: n.sourceType,
    deadline: n.deadline,
    deadlineIsOpening: deadlineIsOpening(n),
    registrationDeadline: registrationDeadlineOf(n),
    budgetAmount: n.budgetAmount,
    postedAt: n.postedAt,
    detailUrl: n.detailUrl,
    /** 공고에 분류된 세부품명 — 화면의 '세부품명' 드롭다운 (보유 품목별 분류) */
    productCode: n.productClsfcNo?.trim() || null,
    productName: n.productClsfcName ?? null,
    bidMethod: n.bidMethod,
    bidMethodCategory: classifyBidMethod(n.bidMethod),
    /** 재공고 — 나라장터 공고종류(ntceKindNm)나 제목에 '재공고'가 있으면 카드에 배지 */
    reNotice: /재공고/.test(String(n.raw.ntceKindNm ?? "")) || /재공고/.test(n.title),
    confidence: m.confidence,
    reason: matchReason(m),
    // 등급 배지 팝업용 — 무엇이 맞아서 목록에 올랐는지 (강력추천 = 품목·업종 코드와 제목 키워드가 둘 다 맞음)
    matchedBy: {
      products: m.matchedProductCodes.map((c) => ({ code: c.code, name: c.name })),
      industries: m.matchedIndustryCodes.map((c) => ({ code: c.code, name: c.name })),
      keywords: m.matchedKeywords,
      classes: (m.matchedServiceClasses ?? []).map((c) => ({ code: c.code, name: c.name })),
    },
    overseas: m.overseasVenueFlag?.matchedMongoliaKeyword ?? null,
    qualification: m.qualification ?? null,
    allowedRegions: allowedRegionsOf(n),
    mainWork: mainWorkOf(n, appConfig.heldIndustries),
    classOnly: isClassOnly(m),
    /** 담당자가 "목록에 올리기"한 공고면 누가·언제·왜 빠졌었는지 */
    promoted: promoted[n.noticeNo] ?? null,
    ...similarity,
  };
}

/**
 * 나라장터 참가가능지역 (본공고만, api/regionLimitApi.ts) — 화면의 지역제한 배지. 본점 지역 밖인 공고는 서버가 이미
 * '참가지역' 단계에서 뺐으니 목록에 남은 것은 모두 본점(강원) 업체가 참가할 수 있는 지역제한이다.
 * [] = 지역제한 없음(전국), null = 사전규격이거나 조회 실패라 모름 — 사전규격은 첨부 공고문에서 읽은 지역(qualDoc.region)을 쓴다.
 */
function allowedRegionsOf(n: NormalizedNotice): string[] | null {
  const map = lastDiagnostics?.context.participationRegions;
  if (n.sourceType !== "본공고" || !map || map.size === 0) return null;
  return map.get(n.noticeNo) ?? [];
}

/** 제외된 공고 카드의 싱크로율 — 제목 비교는 공고마다 한 번만 한다 */
const excludedScoreCache = new Map<string, number>();
function excludedScore(noticeNo: string, title: string): number {
  const fromBody = enrichment.get(noticeNo)?.similarity?.maxScore;
  if (fromBody != null) return fromBody;
  let v = excludedScoreCache.get(noticeNo);
  if (v === undefined) {
    v = similarityView(title).maxScore;
    excludedScoreCache.set(noticeNo, v);
  }
  return v;
}

function noticeSummary(n: NormalizedNotice, d: Diagnosis): unknown {
  const failed = d.steps.find((s) => s.step === d.excludedAt);
  return {
    noticeNo: n.noticeNo,
    title: n.title,
    institution: n.institution,
    demandInstitution: demandInstitutionOf(n),
    businessType: n.businessType,
    sourceType: n.sourceType,
    deadline: n.deadline,
    deadlineIsOpening: deadlineIsOpening(n),
    // '제외된 공고'·검색 카드도 실제 공고 목록과 같은 마감(자격등록 마감 우선)을 보여 준다
    registrationDeadline: registrationDeadlineOf(n),
    budgetAmount: n.budgetAmount,
    postedAt: n.postedAt,
    detailUrl: n.detailUrl,
    bidMethod: n.bidMethod,
    bidMethodCategory: classifyBidMethod(n.bidMethod),
    reNotice: /재공고/.test(String(n.raw.ntceKindNm ?? "")) || /재공고/.test(n.title),
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

/**
 * 공고문에서 읽은 업종 자격 중 지일이 갖고 있지 않은 것(등록만 하면 되는 업종 포함) — 화면(ui.html)의 docQualBlocked와 같은 기준.
 * 나라장터 업종제한이 걸린 공고는 '참가자격' 단계에서 이미 빠졌으니, 업종제한이 없는(사전규격·제한없음·조회실패) 공고만 본다.
 * 첨부를 읽어야 아는 것이라 목록을 만들 때가 아니라 첨부를 읽은 뒤(enrichment)에 가린다 (2026-10-14 요청).
 */
function docQualBlocked(qualificationStatus: string | null, doc: QualificationDocResult | null | undefined): string[] | null {
  if (qualificationStatus !== null && qualificationStatus !== "조회실패" && qualificationStatus !== "제한없음") return null;
  if (!doc || doc.sectionFound === false) return null;
  const keep = keepQualifications();
  const missing = doc.requirements.filter((r) => r.kind === "업종" && !r.held && !r.covered && !isKeptQualification(r, keep));
  if (missing.length === 0) return null;
  // 요구 업종 중 보유한 것이 학술.연구용역뿐이면 빼지 않는다 — 나머지 자격을 가진 업체와 컨소시엄으로 들어갈 만한지
  // 담당자가 본다 (2026-10-15 회의: 대표님). 화면 ui.html consortiumCase와 같은 기준
  const heldNeed = doc.requirements.filter((r) => r.kind === "업종" && r.held);
  if (heldNeed.length > 0 && heldNeed.every((r) => isAcademicQualification(r))) return null;
  return missing.map((r) => r.name ?? r.docName ?? r.code ?? "업종");
}

/** 학술.연구용역(업종코드 1169) — 보유 자격 중 이것만 맞는 공고는 컨소시엄 검토 대상 */
function isAcademicQualification(r: { code: string | null; name: string | null; docName?: string | null }): boolean {
  return r.code === "1169" || /학술.?연구/.test(`${r.name ?? ""} ${r.docName ?? ""}`);
}

/**
 * 보유하지 않아도 공고를 빼지 않는 자격 (keywords.json keepMissingQualifications — 건축사사무소, 2026-10-14 요청).
 * 화면(ui.html docQualBlocked)도 같은 목록을 /api/enrich로 받아 쓴다.
 */
function keepQualifications(): { code: string; name: string }[] {
  return lastDiagnostics?.context.config.keepMissingQualifications ?? [];
}
/** 공고문 자격은 코드가 없는 경우가 많아("건축사사무소 개설(건축사법)") 코드가 아니면 이름 포함으로 맞춘다 — ui.html isKeptQualification과 같은 기준 */
function isKeptQualification(r: { code: string | null; name: string | null; docName?: string | null }, keep: { code: string; name: string }[]): boolean {
  const text = `${r.name ?? ""} ${r.docName ?? ""}`.replace(/\s+/g, "");
  return keep.some((k) => (r.code !== null && r.code === k.code) || text.includes(k.name.replace(/\s+/g, "")));
}

/**
 * 첨부를 읽어 보니 목록에서 뺄 공고 — 화면(ui.html)의 docOut과 같은 기준.
 *  · 공고문 참가자격에 지일이 갖고 있지 않은 업종이 있음 → 참가자격
 *  · 첨부 문서의 지역제한에 본점 소재지가 없음 → 참가지역. 사전규격은 나라장터 참가가능지역 정보가 없어 첨부로만 안다
 *  · 분류로만 들어왔는데 과업지시서에 전시·제작 내용이 없음, 사업 목적이 휴게·독서 공간 조성 → 과업 내용
 * 예전에는 지역제한·과업 내용을 목록 맨 아래 '회사 방향과 다른 공고' 칸에 두었는데, 참가할 수 없거나 본업이 아닌
 * 공고라 '제외된 공고' 탭으로 옮겼다 (2026-10-14 요청).
 */
type ListItem = { noticeNo: string; qualification: { status: string } | null; classOnly: boolean };
function docExclusion(item: ListItem, hq: string | null): { stage: "참가자격" | "참가지역" | "과업 내용"; detail: string } | null {
  const e = enrichment.get(item.noticeNo);
  const missing = docQualBlocked(item.qualification?.status ?? null, e?.qualDoc);
  if (missing) return { stage: "참가자격", detail: `공고문 참가자격에 지일이 갖고 있지 않은 자격이 있습니다 — ${missing.join(", ")}` };
  const region = e?.qualDoc?.region;
  if (region && meetsRegion(region, hq) === false) return { stage: "참가지역", detail: `첨부 문서의 지역제한 — ${region} 업체만 참가` };
  if (item.classOnly && e?.core?.status === "없음") return { stage: "과업 내용", detail: "제목에 키워드가 없고, 과업지시서에도 전시·제작 내용이 없습니다" };
  if (e?.scope?.flags.some((f) => f.kind === "휴게공간")) return { stage: "과업 내용", detail: "사업 목적이 휴게·독서 공간 조성입니다" };
  return null;
}

function docExcluded(diag: CollectionDiagnostics): unknown[] {
  const byNo = new Map(diag.notices.map((n) => [n.noticeNo, n]));
  const hq = loadHeadquartersRegion();
  const out: unknown[] = [];
  for (const item of (noticeCache?.items ?? []) as ListItem[]) {
    // 담당자가 올린 공고는 첨부로도 빼지 않는다
    if (promoted[item.noticeNo]) continue;
    const why = docExclusion(item, hq);
    const notice = byNo.get(item.noticeNo);
    if (!why || !notice) continue;
    out.push(noticeSummary(notice, withDocExclusion(diagnoseNotice(notice, diag.context), why)));
  }
  return out;
}

/** 첨부 문서로 빠진 이유를 조건별 확인 결과에 반영한다 — 같은 단계가 있으면 그 줄을 바꾸고, 없으면 덧붙인다 */
function withDocExclusion(d: Diagnosis, why: NonNullable<ReturnType<typeof docExclusion>>): Diagnosis {
  const marked = d.steps.some((s) => s.step === why.stage);
  const steps = marked
    ? d.steps.map((s) => (s.step === why.stage ? { ...s, ok: false, detail: why.detail } : s))
    : [...d.steps, { step: why.stage, ok: false, detail: why.detail }];
  return { ...d, steps, excludedAt: why.stage };
}

/**
 * 제목의 제외 키워드 **하나 때문에만** 빠진 후보 — 다른 단계(마감·금액·낙찰방법·키워드·자격)는 모두 통과한 공고.
 * 제목만 보고 뺀 것이라 첨부 과업에 본업이 있을 수 있어 다시 읽는다 (2026-10-02 요청).
 */
function titleExcludedCandidates(diag: CollectionDiagnostics): { notice: NormalizedNotice; keyword: string }[] {
  // "제외된 공고" 탭과 같은 계산을 재사용한다 (공고 수만 건 진단을 한 번만)
  const byNo = new Map(diag.notices.map((n) => [n.noticeNo, n]));
  const out: { notice: NormalizedNotice; keyword: string }[] = [];
  for (const item of excludedCandidates(diag).items as { noticeNo: string; excludedAt: string; excludedDetail: string | null; steps: { step: string; ok: boolean }[] }[]) {
    if (item.excludedAt !== "제외키워드") continue;
    if (item.steps.some((s) => s.step !== "제외키워드" && !s.ok)) continue;
    const notice = byNo.get(item.noticeNo);
    if (!notice) continue;
    const detail = item.excludedDetail ?? "";
    out.push({ notice, keyword: /'([^']+)'/.exec(detail)?.[1] ?? detail });
  }
  return out;
}

// ── 참가여부 (담당자끼리 공유) ─────────────────────────────────
/**
 * 공고마다 참가여부·담당자·대화를 cache/participation.json에 둔다. 같은 링크로 들어온
 * 사람 모두가 같은 기록을 본다 — "A가 이미 보고 있다", "보류인데 왜?"를 바로 알 수 있게.
 *
 * 판단(참가·보류·불참)은 사유·판단자·시각과 함께 남기고 화면 '판단 기록' 탭에 모은다. 예전에는 버튼을 누를 때마다
 * 대화에 시스템 기록("상태를 '참가'로 변경")을 쌓았는데, 대화가 로그로 덮여 지우고 대신 한 단계 되돌리기를 둔다
 * (2026-10-15 요청). 판단할 때의 공고 정보(meta)를 같이 남겨 키워드 조정용 집계에 쓴다.
 */
const PARTICIPATION_STATUSES = ["검토중", "참가", "보류", "불참"] as const;
type ParticipationStatus = (typeof PARTICIPATION_STATUSES)[number];
/** 되돌리기용 — 바로 앞 상태 */
interface DecisionSnapshot {
  status: ParticipationStatus | null;
  reason: string;
  tags: string[];
  owner: string;
  autoOwner: boolean;
  decidedBy: string;
  decidedAt: string | null;
}
interface Participation {
  noticeNo: string;
  title: string;
  status: ParticipationStatus | null;
  owner: string;
  updatedAt: string;
  comments: { by: string; text: string; at: string; system?: boolean }[];
  /** 보류·불참의 주된 사유 버튼 (여러 개) — 화면 REASON_TAGS */
  tags?: string[];
  /** 판단 사유 (참가·보류·불참을 고를 때 적는다) */
  reason?: string;
  decidedBy?: string;
  decidedAt?: string | null;
  /** 판단할 때의 공고 정보 — 판단 기록 CSV·키워드 조정용 집계 */
  meta?: Record<string, unknown>;
  prev?: DecisionSnapshot | null;
  /** 담당이 참가여부를 고르면서 자동으로 정해졌는지 — 선택을 해제하면 같이 지운다. '내가 맡기'로 직접 맡으면 false */
  autoOwner?: boolean;
}
const PARTICIPATION_PATH = resolve("cache/participation.json");

let participation: Record<string, Participation> = (() => {
  try {
    const all = JSON.parse(readFileSync(PARTICIPATION_PATH, "utf8")) as Record<string, Participation>;
    // 예전 시스템 기록("상태를 … 변경", "담당자: …", "목록에 올림")은 지운다 — 다음 저장 때 파일에서도 빠진다
    for (const p of Object.values(all)) p.comments = (p.comments ?? []).filter((c) => !c.system);
    return all;
  } catch {
    return {};
  }
})();
/** 사유 버튼 값 — 짧은 글자만, 많아야 12개 */
const cleanTags = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().slice(0, 30)).filter(Boolean))].slice(0, 12) : [];
const snapshotOf = (p: Participation): DecisionSnapshot => ({
  status: p.status,
  reason: p.reason ?? "",
  tags: p.tags ?? [],
  owner: p.owner,
  autoOwner: p.autoOwner ?? false,
  decidedBy: p.decidedBy ?? "",
  decidedAt: p.decidedAt ?? null,
});
function saveParticipation(): void {
  mkdirSync(dirname(PARTICIPATION_PATH), { recursive: true });
  writeFileSync(PARTICIPATION_PATH, JSON.stringify(participation, null, 2), "utf8");
}

// ── 담당자가 목록에 올린 공고 (팀 공유) ─────────────────────────
/**
 * "첨부로 다시 볼 공고"에서 담당자가 우리 일이라고 판단해 본 목록에 올린 공고 (2026-10-02 요청).
 * 제목의 제외 키워드만 건너뛰고(pipeline forceInclude) 나머지 조건은 그대로 본다.
 * 참가여부처럼 cache/promoted.json에 두어 팀원 모두 같은 목록을 보고, 다시 조회해도 유지된다.
 */
interface Promotion {
  by: string;
  at: string;
  title: string;
  /** 목록에서 빠졌던 이유 (제목의 제외 키워드) */
  keyword: string;
  /** 빠졌던 사유 (제외된 공고 탭에서 올린 경우 — "수의계약·설계공모" 등). 없으면 제목의 제외 키워드로 빠진 것 */
  reason?: string;
}
const PROMOTED_PATH = resolve("cache/promoted.json");
let promoted: Record<string, Promotion> = (() => {
  try {
    return JSON.parse(readFileSync(PROMOTED_PATH, "utf8")) as Record<string, Promotion>;
  } catch {
    return {};
  }
})();
function savePromoted(): void {
  mkdirSync(dirname(PROMOTED_PATH), { recursive: true });
  writeFileSync(PROMOTED_PATH, JSON.stringify(promoted, null, 2), "utf8");
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
  /** 공고문·분류에 나온 세부품명번호의 분류 경로·해설 (조달청 물품목록정보서비스) */
  classes?: Record<string, ProductClassInfo>;
  /** 첨부 과업지시서·제안요청서 본문 기준 싱크로율. 본문을 못 읽었으면 null (제목 기준 값 그대로) */
  similarity?: SimilarityView | null;
  /** 과업 본문에서 찾은 본업 밖 업무(유물 운송·대여·운영·홍보). 본문을 못 읽었으면 null */
  scope?: { flags: ScopeFlag[]; sourceFile: string } | null;
  /**
   * 조달분류만으로 들어온 공고의 과업 확인. 확인: 본문에 본업 낱말이 있음, 없음: 본문을 읽었는데 없음(화면에서 숨김),
   * 못읽음: 첨부를 읽지 못함(목록에 두고 직접 확인하라고 알림)
   */
  core?: { status: "확인" | "없음" | "못읽음"; words: string[]; sourceFile: string | null };
  /**
   * 제목의 제외 키워드로 빠진 공고를 첨부로 다시 본 결과. 있음: 본업 대상 + 제작·설치 문장이 MAKE_EVIDENCE_MIN번 이상,
   * 없음: 읽었는데 부족, 못읽음: 첨부를 못 읽음. samples는 근거 문장 (화면에서 걸린 말을 강조)
   */
  /**
   * 과업지시서·제안요청서에서 읽은 제안서 제출 일정 — 공고문(qualDoc.submissionDeadline)에 없을 때 화면이 쓴다
   * (2026-10-02 요청: 공고문에 없으면 과업지시서·제안요청서에서). 본문을 못 읽었거나 없으면 null
   */
  specSubmission?: SubmissionDeadline | null;
  rescue?: { status: "있음" | "없음" | "못읽음"; count: number; samples: { sentence: string; match: string }[]; sourceFile: string | null };
}
const enrichment = new Map<string, Enrichment>();
let enrichState = { running: false, done: 0, total: 0 };

function heldOf(appConfig: AppConfig) {
  return { products: appConfig.heldProducts, industries: appConfig.heldIndustries };
}

/** 공고문 요건·공고 분류에 나온 세부품명번호마다 분류 경로를 조회한다 (캐시가 있어 대부분 즉시 끝난다). */
async function classesFor(doc: QualificationDocResult | null): Promise<Record<string, ProductClassInfo>> {
  if (!doc) return {};
  const codes = new Set<string>([
    ...doc.requirements.filter((r) => r.kind === "품명" && r.code).map((r) => r.code!),
    ...(doc.classifiedItems ?? []).map((i) => i.code),
  ]);
  const key = loadEnv().naraBidServiceKey;
  const out: Record<string, ProductClassInfo> = {};
  for (const code of codes) {
    const info = await lookupProductClass(key, code).catch(() => null);
    if (info) out[code] = info;
  }
  return out;
}

/**
 * docOnly: 마감된 공고. 왜 놓쳤는지 첨부로 확인하려는 용도라 진행 중인 공고를 먼저 읽고 그 뒤에 읽는다.
 * rescue: 제목의 제외 키워드로 빠진 후보 — 맨 마지막에 첨부만 읽어 본업 근거(findMakeEvidence)를 찾는다.
 */
function startEnrichment(activeMatches: MatchedNotice[], appConfig: AppConfig, docOnly: MatchedNotice[] = [], rescue: NormalizedNotice[] = []): void {
  if (enrichState.running) return;
  const matches = [...activeMatches, ...docOnly];
  // 공고문 참가자격은 본공고·사전규격 모두 읽는다 (사전규격은 면허제한 API가 없어 첨부가 유일한 근거).
  // 공동수급은 g2b 상세 API가 본공고에만 있다.
  const isBid = (n: NormalizedNotice) => n.sourceType === "본공고";
  const classOnly = new Set(matches.filter(isClassOnly).map((m) => m.notice.noticeNo));
  const docTodo = matches.map((m) => m.notice).filter((n) => {
    const e = enrichment.get(n.noticeNo);
    return (
      !e ||
      e.qualDoc === undefined ||
      e.classes === undefined ||
      e.similarity === undefined ||
      e.scope === undefined ||
      (classOnly.has(n.noticeNo) && e.core === undefined) ||
      (isBid(n) && e.jointBid === undefined)
    );
  });
  const rescueTodo = rescue.filter((n) => enrichment.get(n.noticeNo)?.rescue === undefined);
  if (docTodo.length === 0 && rescueTodo.length === 0) return;
  enrichState = { running: true, done: 0, total: docTodo.length + rescueTodo.length };
  const held = heldOf(appConfig);

  void (async () => {
    try {
      // 1) 공고문·공동수급
      const cookie = await getSessionCookie();
      for (const n of docTodo) {
        const e = enrichment.get(n.noticeNo) ?? {};
        if (isBid(n) && e.jointBid === undefined) e.jointBid = await fetchJointBidStatus(n, cookie).catch(() => null);
        if (e.qualDoc === undefined) e.qualDoc = await readQualificationFromNotice(n, held).catch(() => null);
        if (e.classes === undefined) e.classes = await classesFor(e.qualDoc ?? null);
        const needCore = classOnly.has(n.noticeNo) && e.core === undefined;
        if (e.similarity === undefined || e.scope === undefined || needCore) {
          const body = await fetchNoticeBody(n).catch(() => null);
          // 과업지시서가 없으면 입찰공고문 개요·공내역서에서 근거 키워드만 찾는다 (점수는 제목 기준 그대로)
          const outline = body ? null : await fetchNoticeOutline(n).catch(() => null);
          e.similarity = body ? similarityView(n.title, body) : outline ? similarityView(n.title, undefined, outline.text) : null;
          e.scope = body ? { flags: body.scopeFlags, sourceFile: body.sourceFile } : null;
          e.specSubmission = body ? findSubmissionDeadline(body.text) : null;
          if (needCore) {
            const words = body ? findCoreWords(body.text, appConfig.keywords) : [];
            e.core = { status: !body ? "못읽음" : words.length ? "확인" : "없음", words: words.slice(0, 4), sourceFile: body?.sourceFile ?? null };
          }
        }
        enrichment.set(n.noticeNo, e);
        enrichState.done += 1;
        await new Promise((r) => setTimeout(r, 300)); // g2b·조달청 서버에 몰아서 요청하지 않는다
      }

      // 2) 제목으로 빠진 후보 — 첨부만 읽어 본업 근거를 찾는다
      for (const n of rescueTodo) {
        const body = await fetchNoticeBody(n).catch(() => null);
        const ev = body ? findMakeEvidence(body.text) : { count: 0, samples: [] };
        const status = !body ? "못읽음" : ev.count >= MAKE_EVIDENCE_MIN ? "있음" : "없음";
        enrichment.set(n.noticeNo, { ...enrichment.get(n.noticeNo), rescue: { status, ...ev, sourceFile: body?.sourceFile ?? null } });
        enrichState.done += 1;
        await new Promise((r) => setTimeout(r, 300));
      }

    } finally {
      enrichState.running = false;
    }
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


/**
 * 보유 세부품명 공고 — 공고에 분류된 세부품명이 지일 보유 품목(held-qualifications.json heldProducts)과 같은데
 * 키워드·금액 등으로 목록에 없던 공고 (2026-10-15 회의: 대표님 — 품목 제한 공고는 경쟁률이 20:1 수준이라 찾아서 추천).
 * 수집 기준 파일(codes.json)에 없는 보유 품목(수족관·스튜디오용카메라 등)도 여기서 잡힌다. 본 목록에 섞지 않고 따로 보여 준다 —
 * 책상·소프트웨어처럼 범위가 넓은 품목은 무관한 구매 공고도 많아서다. 마감 지난 공고와 본공고가 따로 나온 사전규격은 뺀다.
 */
function heldProductCandidates(appConfig: AppConfig, listed: Set<string>): unknown[] {
  const diag = lastDiagnostics;
  if (!diag) return [];
  const held = new Map(appConfig.heldProducts.map((c) => [c.code.trim(), c.name]));
  const out: unknown[] = [];
  for (const n of diag.notices) {
    const code = n.productClsfcNo?.trim();
    if (!code || !held.has(code) || listed.has(n.noticeNo) || promoted[n.noticeNo]) continue;
    const d = diagnoseNotice(n, diag.context);
    if (d.excludedAt === "마감" || d.excludedAt === "본공고 게시") continue;
    const failed = d.steps.find((s) => s.step === d.excludedAt);
    out.push({
      noticeNo: n.noticeNo,
      title: n.title,
      institution: n.institution,
      demandInstitution: demandInstitutionOf(n),
      sourceType: n.sourceType,
      businessType: n.businessType,
      deadline: n.deadline,
      deadlineIsOpening: deadlineIsOpening(n),
      registrationDeadline: registrationDeadlineOf(n),
      budgetAmount: n.budgetAmount,
      detailUrl: n.detailUrl,
      bidMethod: n.bidMethod,
      bidMethodCategory: classifyBidMethod(n.bidMethod),
      productCode: code,
      productName: held.get(code),
      reNotice: /재공고/.test(String(n.raw.ntceKindNm ?? "")) || /재공고/.test(n.title),
      maxScore: excludedScore(n.noticeNo, n.title),
      excludedAt: d.excludedAt,
      excludedDetail: failed?.detail ?? null,
    });
  }
  return out;
}

async function fetchNotices(period: string): Promise<NoticeCache> {
  const { lookbackDays, preStandardLookbackDays, incremental, label: periodLabel } = periodOptions(period);
  try {
    const env = loadEnv();
    const appConfig = loadAppConfig();
    const input = await collectReportInput(env, appConfig, {
      lookbackDays,
      preStandardLookbackDays,
      incremental,
      withDiagnostics: true,
      withClosed: true,
      forceInclude: new Set(Object.keys(promoted)),
    });
    lastDiagnostics = input.diagnostics ?? null;
    // 이미 목록에 올린 공고는 "첨부로 다시 볼 공고"에서 뺀다 (본 목록에 있다)
    const titleExcluded = (lastDiagnostics ? titleExcludedCandidates(lastDiagnostics) : []).filter((x) => !promoted[x.notice.noticeNo]);
    startEnrichment(
      [...input.bid.matches, ...input.preStandard.matches],
      appConfig,
      input.closed ?? [],
      titleExcluded.map((x) => x.notice)
    );
    const all = [...input.bid.matches, ...input.preStandard.matches];
    // 유사도 높은 순. 기존 리포트는 추천등급→마감일 순인데, 여기서는 ④가 무엇을
    // 끌어올리는지 보는 게 목적이라 일부러 유사도로 세운다.
    const items = all.map((m) => decorate(m, appConfig)).sort((a, b) => (b as { maxScore: number }).maxScore - (a as { maxScore: number }).maxScore);
    // 마감된 공고는 진행 중인 공고 뒤에 첨부를 읽는다 (startEnrichment docOnly)
    const closedItems = (input.closed ?? [])
      .sort((a, b) => (parseKstDateTime(b.notice.deadline)?.getTime() ?? 0) - (parseKstDateTime(a.notice.deadline)?.getTime() ?? 0))
      .map((m) => decorate(m, appConfig));
    const titleExcludedItems = titleExcluded.map(({ notice, keyword }) => ({
      noticeNo: notice.noticeNo,
      title: notice.title,
      institution: notice.institution,
      demandInstitution: demandInstitutionOf(notice),
      sourceType: notice.sourceType,
      businessType: notice.businessType,
      deadline: notice.deadline,
      deadlineIsOpening: deadlineIsOpening(notice),
      // 검토필요 카드 — 본공고 카드처럼 마감·낙찰방법·싱크로율을 함께 보여 준다
      registrationDeadline: registrationDeadlineOf(notice),
      budgetAmount: notice.budgetAmount,
      detailUrl: notice.detailUrl,
      bidMethod: notice.bidMethod,
      bidMethodCategory: classifyBidMethod(notice.bidMethod),
      reNotice: /재공고/.test(String(notice.raw.ntceKindNm ?? "")) || /재공고/.test(notice.title),
      maxScore: excludedScore(notice.noticeNo, notice.title),
      excludeKeyword: keyword,
      // 제목·세부품명에 든 관심 키워드 — 제외 키워드와 함께 있으면 화면 '검토필요' 칸에 모은다 (2026-10-15 요청)
      interestKeywords: matchKeywords(notice, appConfig.keywords),
    }));
    const collected = {
      bid: lastDiagnostics?.notices.filter((n) => n.sourceType === "본공고").length ?? 0,
      pre: lastDiagnostics?.notices.filter((n) => n.sourceType === "사전규격").length ?? 0,
    };
    const heldItems = heldProductCandidates(appConfig, new Set([...all.map((m) => m.notice.noticeNo), ...titleExcluded.map((x) => x.notice.noticeNo)]));
    const heldProducts = appConfig.heldProducts.map((c) => ({ code: c.code.trim(), name: c.name }));
    return { fetchedAt: new Date(), period, periodLabel, items, closedItems, titleExcludedItems, heldItems, heldProducts, collected, error: null };
  } catch (err) {
    return { fetchedAt: new Date(), period, periodLabel, items: [], closedItems: [], titleExcludedItems: [], error: String(err) };
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
    // 1년 — 한 번 링크로 들어온 뒤에는 즐겨찾기한 http://jiil-bid.local 만으로 들어올 수 있게
    res.setHeader("set-cookie", `ui_token=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
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
      // 화면 파일을 고치면 새로고침만으로 반영돼야 한다 — 캐시 헤더가 없으면 브라우저가 옛 화면을 쥐고 있다
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
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

  // 과거 사업 한 건의 과업 요약 (과거 사업 탭에서 사업명을 눌렀을 때)
  if (url.pathname === "/api/project") {
    const project = byId.get(url.searchParams.get("id") ?? "");
    json(res, { excerpt: project && project.body.length > 0 ? taskExcerpt(project.body, 3000) : null });
    return;
  }

  if (url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) {
      json(res, { maxScore: 0, top: [] });
      return;
    }
    void (async () => {
      // 공고번호(R26BK01723875, 20260912345-00 등)를 넣으면 이번에 불러온 공고에서 찾아 제목과 첨부 과업지시서로
      // 비교한다 — 담당자는 공고번호를 들고 오는 일이 많고, 제목 한 줄보다 과업 본문이 훨씬 정확하다.
      let notice: NormalizedNotice | null = null;
      let noticeMissing: "notLoaded" | "notFound" | null = null;
      if (/^[A-Za-z]\d{2}[A-Za-z]{2}\d{6,}(-\d+)?$|^\d{11,}(-\d+)?$/.test(q)) {
        const needle = q.split("-")[0]!.toLowerCase();
        notice = lastDiagnostics?.notices.find((n) => n.noticeNo.toLowerCase().startsWith(needle)) ?? null;
        if (!notice) noticeMissing = lastDiagnostics ? "notFound" : "notLoaded";
      }
      if (noticeMissing) return json(res, { maxScore: 0, top: [], notice: null, noticeMissing });

      const body = notice ? await fetchNoticeBody(notice).catch(() => null) : null;
      const result = index.findSimilar(notice ? notice.title : q, 10, body ? { body: body.text, keywordText: body.fullText } : {});
      json(res, {
        maxScore: calibrate(result.maxScore, result.basis),
        basis: result.basis,
        notice: notice
          ? { ...(noticeSummary(notice, diagnoseNotice(notice, lastDiagnostics!.context)) as object), demandInstitution: demandInstitutionOf(notice) }
          : null,
        top: result.top.map((m) => {
          const project = byId.get(m.id);
          return {
            name: m.name,
            year: m.year,
            // 화면에는 담당자가 읽는 싱크로율(%)만 쓴다 — 원점수는 보이지 않는다
            shown: calibrate(m.score, result.basis),
            budgetAmount: project?.budgetAmount ?? null,
            // 맨 앞을 자르면 표지·목차만 보여서, 목차를 건너뛴 과업 개요·목적·범위 부분을 뽑는다.
            // 전체 본문을 넘기지 않는다 — 사람이 "이 사업이 맞나" 확인하는 데는 과업 요약이면 된다.
            excerpt: project && project.body.length > 0 ? taskExcerpt(project.body) : null,
          };
        }),
      });
    })().catch((err) => json(res, { error: String(err) }));
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
    const base = excludedCandidates(lastDiagnostics);
    const fromDoc = docExcluded(lastDiagnostics) as { excludedAt: string }[];
    // 담당자가 목록에 올린 공고는 실제 공고 목록에 있다 — 여기서는 뺀다
    type ExItem = { noticeNo: string; title: string; excludedAt: string };
    const baseKept = (base.items as ExItem[]).filter((n) => !promoted[n.noticeNo]);
    // 카드 오른쪽 싱크로율 — 첨부를 읽은 공고는 그 값, 아니면 제목으로 (공고마다 한 번만 계산)
    const items = [...(fromDoc as ExItem[]), ...baseKept].map((n) => ({ ...n, maxScore: excludedScore(n.noticeNo, n.title) }));
    const byStage = Object.fromEntries(Object.keys(base.byStage).map((s) => [s, 0])) as Record<string, number>;
    for (const n of items) byStage[n.excludedAt] = (byStage[n.excludedAt] ?? 0) + 1;
    // keywords: 카드의 "관심 키워드 N개 보기"
    json(res, { periodLabel: noticeCache?.periodLabel ?? null, fetchedAt: noticeCache?.fetchedAt ?? null, total: lastDiagnostics.notices.length, byStage, items, keywords: lastDiagnostics.context.config.keywords });
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
    // 나라장터 정보로는 통과해도 첨부 문서(공고문 참가자격·지역제한·과업)로 목록에서 빠진 공고가 있다 —
    // 목록·'제외된 공고' 탭과 같은 판정을 써야 "목록에 있음"으로 잘못 나오지 않는다
    // (2026-10-14 가천대 의과대학 공간조성 설계용역: 공고문에 건축사사무소 신고 요구)
    const listed = new Map(((noticeCache?.items ?? []) as ListItem[]).map((it) => [it.noticeNo, it]));
    const hq = loadHeadquartersRegion();
    json(res, {
      periodLabel: noticeCache?.periodLabel ?? null,
      total: lastDiagnostics.notices.length,
      items: found.map((n) => {
        const d = diagnoseNotice(n, lastDiagnostics!.context);
        const item = d.excludedAt === null ? listed.get(n.noticeNo) : undefined;
        const why = item ? docExclusion(item, hq) : null;
        return noticeSummary(n, why ? withDocExclusion(d, why) : d);
      }),
    });
    return;
  }

  if (url.pathname === "/api/enrich") {
    const hq = loadHeadquartersRegion();
    const byNo = Object.fromEntries(
      [...enrichment].map(([no, e]) => [no, { ...e, regionOk: e.qualDoc?.region ? meetsRegion(e.qualDoc.region, hq) : null }])
    );
    json(res, { ...enrichState, headquartersRegion: hq, keepQualifications: keepQualifications(), byNo });
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
        const b = JSON.parse(raw) as {
          noticeNo?: string;
          title?: string;
          by?: string;
          status?: string;
          reason?: string;
          tags?: unknown;
          owner?: string;
          comment?: string;
          undo?: boolean;
          meta?: Record<string, unknown>;
        };
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

        // 되돌리기 — 바로 앞 판단·담당으로 (한 단계)
        if (b.undo) {
          if (!p.prev) throw new Error("되돌릴 판단이 없습니다");
          Object.assign(p, p.prev, { prev: null });
        }
        if (b.status !== undefined) {
          const status = b.status === "" ? null : (b.status as ParticipationStatus);
          if (status !== null && !PARTICIPATION_STATUSES.includes(status)) throw new Error("알 수 없는 상태입니다");
          if (status !== p.status) {
            p.prev = snapshotOf(p);
            p.status = status;
            p.reason = String(b.reason ?? "").trim().slice(0, 500);
            p.tags = cleanTags(b.tags);
            p.decidedBy = status ? by : "";
            p.decidedAt = status ? now : null;
            if (b.meta && typeof b.meta === "object" && JSON.stringify(b.meta).length <= 4000) p.meta = b.meta;
          }
          // 처음 상태를 정한 사람이 담당자가 된다 (따로 지정하지 않았다면). 선택을 해제하면 자동으로 정한 담당도 지운다 —
          // 판단이 없는데 담당 이름만 남아 있으면 누가 맡은 것처럼 보인다 (2026-10-15 요청). 예전 기록(표시 없음)도 자동으로 본다
          if (status && !p.owner) {
            p.owner = by;
            p.autoOwner = true;
          } else if (!status && p.owner && p.autoOwner !== false) {
            p.owner = "";
            p.autoOwner = false;
          }
        } else {
          // 사유·사유 버튼만 고치기 — 되돌리기 대상이 아니다
          if (b.reason !== undefined) p.reason = String(b.reason).trim().slice(0, 500);
          if (b.tags !== undefined) p.tags = cleanTags(b.tags);
        }
        if (b.owner !== undefined) {
          const owner = String(b.owner).trim().slice(0, 40);
          if (owner !== p.owner) {
            p.prev = snapshotOf(p);
            p.owner = owner;
          }
          p.autoOwner = false;
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

  // 담당자가 빠진 공고를 목록에 올리기·다시 빼기 ('검토필요'·'첨부로 다시 볼 공고'·'제외된 공고' 탭의 버튼)
  if (url.pathname === "/api/promote" && req.method === "POST") {
    if (!(req.headers["content-type"] ?? "").includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "application/json만 받습니다." }));
      return;
    }
    readBody(req)
      .then((raw) => {
        const b = JSON.parse(raw) as { noticeNo?: string; title?: string; keyword?: string; reason?: string; by?: string; on?: boolean };
        const noticeNo = String(b.noticeNo ?? "").trim();
        const by = String(b.by ?? "").trim().slice(0, 40);
        if (!noticeNo) throw new Error("공고번호가 없습니다");
        if (!by) throw new Error("이름을 먼저 입력하세요");
        if (b.on) {
          const keyword = String(b.keyword ?? "").slice(0, 60);
          const title = String(b.title ?? "").slice(0, 300);
          const reason = String(b.reason ?? "").slice(0, 200);
          promoted[noticeNo] = { by, at: new Date().toISOString(), title, keyword, ...(reason ? { reason } : {}) };
        } else if (promoted[noticeNo]) {
          delete promoted[noticeNo];
        }
        savePromoted();
        // 다음 조회에서 목록을 다시 만든다 (받아 둔 공고를 다시 쓰므로 나라장터에 새로 묻지 않는 한 빠르다)
        noticeCache = null;
        json(res, { ok: true, promoted });
      })
      .catch((err: unknown) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      });
    return;
  }

  if (url.pathname === "/api/notices") {
    const period = url.searchParams.get("days") ?? "7";
    const refresh = url.searchParams.get("refresh") === "1";

    if (!refresh && noticeCache && noticeCache.period === period) {
      json(res, { ...noticeCache, cached: true });
      return;
    }

    // 조회가 도는 중에 새로고침을 또 누르면 같은 약속을 돌려준다 —
    // API를 두 번 때리면 느려질 뿐 아니라 일일 호출 한도를 두 배로 쓴다.
    // 기간이 다르면 따로 조회한다.
    let running = inFlight.get(period);
    if (!running) {
      running = fetchNotices(period).then((result) => {
        noticeCache = result;
        inFlight.delete(period);
        return result;
      });
      inFlight.set(period, running);
    }
    running
      .then((result) => json(res, { ...result, cached: false }))
      .catch((err: unknown) => {
        inFlight.delete(period);
        json(res, { fetchedAt: new Date(), period, periodLabel: periodOptions(period).label, items: [], closedItems: [], titleExcludedItems: [], error: String(err), cached: false });
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
    const port = PORT === 80 ? "" : `:${PORT}`;
    if (HOSTNAME) announceName(HOSTNAME, lanAddress, (msg) => console.log(`\n  ${msg}`));
    const share = `http://${HOSTNAME ? `${HOSTNAME}.local` : lanAddress()}${port}/?t=${TOKEN}`;
    console.log(`\n  팀원에게 보낼 주소 (이 줄 전체를 복사하세요)`);
    console.log(`  ${share}`);
    if (HOSTNAME) console.log(`  (이름으로 안 열리는 기기는: http://${lanAddress()}${port}/?t=${TOKEN})`);
    console.log(`\n  · 같은 사내망에 있는 기기만 접속할 수 있습니다.`);
    console.log(`  · 이 PC가 켜져 있고 이 창이 떠 있는 동안만 동작합니다.`);
    console.log(`  · 화면에 과업지시서 본문과 발주기관 담당자 연락처가 나옵니다.`);
    console.log(`    사내 공유용이며, 외부로 주소를 전달하지 마세요.`);
  }
  console.log(`\n  종료: Ctrl+C\n`);
});
