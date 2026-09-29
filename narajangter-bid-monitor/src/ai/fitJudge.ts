import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { CodeEntry } from "../config/loadJsonConfig.js";
import type { NormalizedNotice } from "../api/types.js";
import type { QualificationDocResult } from "../matching/qualificationDoc.js";
import { redactPersonal } from "../redactPersonal.js";

/**
 * ⑤ AI 적합성 판단 — "이 공고가 지일에 맞는가, 아니라면 왜 아닌가".
 *
 * 규칙(①~④)은 키워드·코드·자격으로 후보를 좁히는 데까지만 한다. 제목에 "과학관"이 있어도 실제로는
 * 운영 용역이거나, 자격은 되는데 공동수급 불허에 규모가 너무 크거나 하는 판단은 규칙으로 못 한다.
 * 그걸 Claude에게 맡기고, 결론보다 **이유**를 받는다 — 담당자가 이유를 보고 동의·반대할 수 있어야
 * 쓸모가 있다.
 *
 * 회사 소개는 config/company-profile.json, 보유 자격은 held-qualifications.json, 과거 수행사업은
 * data/past-projects.json(있을 때만)에서 읽어 시스템 프롬프트로 고정한다. 공고마다 바뀌는 것은
 * 사용자 메시지로만 보내서 시스템 프롬프트가 캐시되게 한다.
 */

export const AI_MODEL = "claude-opus-5";

export const FitJudgmentSchema = z.object({
  verdict: z.enum(["적절", "검토필요", "부적절"]),
  summary: z.string(),
  reasons: z.array(z.string()),
  risks: z.array(z.string()),
});
export type FitJudgment = z.infer<typeof FitJudgmentSchema>;

export interface FitInput {
  notice: NormalizedNotice;
  /** 규칙 매칭 근거 (예: "키워드 과학관 / 품목 조형물") */
  matchReason: string;
  /** 면허제한정보 판정 요약 (예: "충족 — 실내건축공사업(4990)") */
  qualificationSummary: string | null;
  qualDoc: QualificationDocResult | null;
  jointBid: string | null;
  /** 과업지시서·제안요청서 본문 (첨부를 읽은 경우) */
  taskText: string | null;
  /** 싱크로율 상위 과거사업 */
  similarPast: { name: string; year: number; score: number }[];
}

interface CompanyProfile {
  name: string;
  headquartersRegion: string | null;
  coreBusiness: string[];
  notOurBusiness: string[];
  judgmentNotes: string[];
}

function configDir(): string {
  return process.env.APP_CONFIG_DIR ? path.resolve(process.env.APP_CONFIG_DIR) : path.resolve("config");
}

/** 키가 없으면 AI 판단을 건너뛴다. SDK는 API 키 외에 AUTH_TOKEN도 읽으므로 둘 다 본다. */
export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
}

/**
 * 시스템 프롬프트. 공고와 무관하게 늘 같아야 캐시가 맞는다 — 날짜·시각 같은 가변 값을 넣지 않는다.
 */
export function buildSystemPrompt(
  profile: CompanyProfile,
  held: { products: CodeEntry[]; industries: CodeEntry[] },
  pastProjects: { year: number; name: string }[]
): string {
  const list = (items: string[]) => items.map((s) => `- ${s}`).join("\n");
  const past = pastProjects.length
    ? pastProjects
        .slice()
        .sort((a, b) => b.year - a.year)
        .map((p) => `- ${p.year} ${p.name}`)
        .join("\n")
    : "(자료 없음)";
  return `당신은 ${profile.name}의 입찰 담당자를 돕는 검토자입니다. 나라장터 공고 하나를 보고, 이 회사가 참가할 만한 공고인지 판단하고 그 이유를 한국어로 설명합니다.

담당자는 당신의 설명을 보고 참가 여부를 정합니다. 결론보다 이유가 중요합니다 — 공고의 어떤 사실 때문에 그렇게 판단했는지 구체적으로 적으세요. 추측과 사실을 구분하고, 공고 정보에 없는 것은 "공고에 없음"이라고 쓰세요.

## 회사가 하는 일
${list(profile.coreBusiness)}

## 회사가 하지 않는 일
${list(profile.notOurBusiness)}

## 판단할 때 참고할 것
${list(profile.judgmentNotes)}
- 본점 소재지: ${profile.headquartersRegion ?? "미확인 — 지역제한 공고는 '확인 필요' 위험으로만 적으세요"}

## 보유 자격
등록업종: ${held.industries.map((c) => `${c.name}(${c.code})`).join(", ")}
등록물품(세부품명): ${held.products.map((c) => `${c.name}(${c.code})`).join(", ")}

## 과거 수행사업
${past}

## 답변 형식
- verdict: "적절"(회사 핵심 사업이고 참가에 큰 걸림돌이 없음), "검토필요"(사업은 맞지만 자격·규모·조건 확인이 필요하거나 판단 근거가 부족함), "부적절"(회사 사업이 아니거나 참가할 수 없음) 중 하나
- summary: 한 문장 결론 (예: "과학관 전시물 제작·설치로 핵심 사업에 해당하나 공동수급 불허라 규모 검토 필요")
- reasons: 판단 근거 2~4개. 공고의 구체적 사실(과업 내용, 발주 형태, 과거사업과의 유사성)을 들어 쓰세요. 부적절이면 왜 회사 일이 아닌지를 먼저 쓰세요.
- risks: 참가 걸림돌 (자격 미보유, 지역제한, 지명경쟁, 공동수급 불허, 규모, 짧은 마감 등). 없으면 빈 배열.`;
}

export function buildNoticeMessage(input: FitInput): string {
  const n = input.notice;
  const won = (v: number | null) => (v == null ? "공고에 없음" : `${Math.round(v).toLocaleString("ko-KR")}원`);
  const lines = [
    `공고명: ${n.title}`,
    `구분: ${n.sourceType} / ${n.businessType}`,
    `발주기관: ${n.institution ?? "공고에 없음"}`,
    `예산(추정가격 등): ${won(n.budgetAmount)}`,
    `낙찰방법: ${n.bidMethod ?? "공고에 없음"}`,
    `마감: ${n.deadline ?? "공고에 없음"}`,
    `규칙 매칭 근거: ${input.matchReason}`,
    `공동수급: ${input.jointBid ?? "확인 안 됨"}`,
    `면허제한정보(API) 판정: ${input.qualificationSummary ?? "대상 아님(사전규격) 또는 정보 없음"}`,
  ];
  if (input.qualDoc) {
    const d = input.qualDoc;
    const req = d.requirements.map((r) => {
      const label = r.name ?? r.docName ?? (r.kind === "품명" ? "세부품명번호" : "업종코드");
      const rel = r.related ? ` [${r.related.level} 보유: ${r.related.items.map((i) => `${i.name}(${i.code})`).join(", ")}]` : "";
      return `${r.held ? "보유" : "미보유"} ${label}${r.code ? `(${r.code})` : ""}${rel}`;
    });
    lines.push(
      `공고문 참가자격에서 찾은 요건: ${req.length ? req.join(", ") : "코드 없음"}`,
      `지역제한: ${d.region ?? "공고문에서 못 찾음"}`,
      `지명경쟁·조합추천: ${d.designated ? (d.jiilDesignated ? "예 (명단에 지일 있음)" : "예 (명단에 지일 없음)") : "아님"}`,
      `공고문 참가자격 발췌:\n${redactPersonal(d.excerpt).text}`
    );
  }
  if (input.similarPast.length) {
    lines.push(`비슷한 과거 수행사업(문자열 유사도 기준): ${input.similarPast.map((p) => `${p.year} ${p.name} (${p.score.toFixed(2)})`).join(" / ")}`);
  }
  lines.push(input.taskText ? `과업지시서·제안요청서 발췌:\n${input.taskText}` : "과업지시서: 첨부 없음 또는 읽지 못함 — 제목과 위 정보로만 판단하세요.");
  return lines.join("\n");
}

let cachedSystem: string | null = null;

function systemPrompt(held: { products: CodeEntry[]; industries: CodeEntry[] }): string {
  if (cachedSystem) return cachedSystem;
  const profile = JSON.parse(readFileSync(path.join(configDir(), "company-profile.json"), "utf8")) as CompanyProfile;
  let past: { year: number; name: string }[] = [];
  try {
    past = JSON.parse(readFileSync(path.resolve(process.env.CORPUS_PATH ?? "data/past-projects.json"), "utf8"));
  } catch {
    /* 코퍼스가 없는 환경 — 과거사업 없이 판단한다 */
  }
  cachedSystem = buildSystemPrompt(profile, held, past);
  return cachedSystem;
}

export type FitResult = { ok: true; judgment: FitJudgment; model: string } | { ok: false; error: string };

let client: Anthropic | null = null;

export async function judgeFit(input: FitInput, held: { products: CodeEntry[]; industries: CodeEntry[] }): Promise<FitResult> {
  if (!isAiConfigured()) return { ok: false, error: "ANTHROPIC_API_KEY가 설정되지 않았습니다" };
  client ??= new Anthropic();
  try {
    const response = await client.beta.messages.parse({
      model: AI_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // 안전 분류기가 드물게 거절하면 같은 요청을 대체 모델로 다시 돌린다 (서버 쪽 처리).
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: systemPrompt(held), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildNoticeMessage(input) }],
      output_config: { format: betaZodOutputFormat(FitJudgmentSchema) },
    });
    if (response.stop_reason === "refusal") return { ok: false, error: "AI가 이 공고에 대한 판단을 거절했습니다" };
    if (!response.parsed_output) return { ok: false, error: `AI 응답을 읽지 못했습니다 (${response.stop_reason})` };
    return { ok: true, judgment: response.parsed_output, model: response.model };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: "API 키가 올바르지 않습니다" };
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: "요청 한도 초과 — 잠시 후 다시 시도하세요" };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Claude API 오류 ${err.status ?? ""}: ${err.message}` };
    return { ok: false, error: String(err) };
  }
}
