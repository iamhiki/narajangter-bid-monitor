import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "../errors.js";
import type { BusinessType } from "../api/types.js";
import { BID_METHOD_CATEGORIES, type BidMethodCategory } from "../matching/bidMethod.js";

// npm 스크립트는 항상 프로젝트 루트(narajangter-bid-monitor/)에서 실행되므로 cwd 기준으로 찾는다.
// (tsx로 src에서 직접 실행하든, tsc로 컴파일된 dist에서 실행하든 경로가 흔들리지 않도록 하기 위함)
// 필요 시 APP_CONFIG_DIR 환경변수로 재정의할 수 있다.
// 호출 시점에 평가해야 테스트 등에서 실행 도중 환경변수를 바꿔도 반영된다.
function resolveConfigDir(): string {
  return process.env.APP_CONFIG_DIR
    ? path.resolve(process.env.APP_CONFIG_DIR)
    : path.resolve(process.cwd(), "config");
}

const emailSchema = z.string().trim().email();

const codeEntrySchema = z.object({
  code: z.string().trim().min(1, "code는 비어있을 수 없습니다"),
  name: z.string().trim().min(1, "name은 비어있을 수 없습니다"),
  requiresKeyword: z.boolean().optional(),
});

/**
 * 수집할 업무구분. 나라장터는 공고를 물품/용역/공사로 나누고 각각 별도 오퍼레이션으로 제공한다.
 * 여기서 뺀 구분은 애초에 조회하지 않으므로, 결과에서 안 보일 뿐 아니라 조회도 그만큼 빨라진다.
 */
const businessTypeSchema = z.enum(["물품", "용역", "공사"]);

const keywordsFileSchema = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1, "keywords 배열이 비어있습니다"),
  excludeKeywords: z.array(z.string().trim().min(1)).default([]),
  softExcludeKeywords: z.array(z.string().trim().min(1)).default([]),
  makeSignals: z.array(z.string().trim().min(1)).default([]),
  excludeKeywordExceptions: z.record(z.array(z.string().trim().min(1))).default({}),
  minBudgetAmount: z.number().nonnegative().nullable().default(null),
  businessTypes: z
    .array(businessTypeSchema)
    .min(1, "businessTypes 배열이 비어있습니다 (최소 1개 필요)")
    .default(["물품", "용역", "공사"]),
  /**
   * 남길 낙찰방법 분류 (matching/bidMethod.ts의 classifyBidMethod). 기본은 전부 허용.
   * 낙찰방법을 아직 알 수 없는 공고(bidMethod가 null — 사전규격은 이 단계에서 항상 그렇고,
   * 본공고도 필드 인식이 빗나가면 null일 수 있음)는 fail-open으로 거르지 않는다 — 걸러도
   * 되는지 판단할 근거가 없는데 지운다면 실제 기회를 놓칠 수 있기 때문이다.
   */
  allowedBidMethods: z
    .array(z.enum(BID_METHOD_CATEGORIES))
    .min(1, "allowedBidMethods 배열이 비어있습니다 (최소 1개 필요)")
    .default([...BID_METHOD_CATEGORIES]),
});

const codesFileSchema = z.object({
  productCodes: z.array(codeEntrySchema).min(1, "productCodes 배열이 비어있습니다"),
  industryCodes: z.array(codeEntrySchema).min(1, "industryCodes 배열이 비어있습니다"),
});

const recipientsFileSchema = z.object({
  recipients: z.array(emailSchema).min(1, "recipients 배열이 비어있습니다 (최소 1명 필요)"),
});

const heldQualificationsFileSchema = z.object({
  heldProducts: z.array(codeEntrySchema).min(1, "heldProducts 배열이 비어있습니다"),
  heldIndustries: z.array(codeEntrySchema).min(1, "heldIndustries 배열이 비어있습니다"),
});

function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigError(`설정 파일을 읽을 수 없습니다: ${filePath}\n${err instanceof Error ? err.message : err}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`설정 파일 JSON 파싱 실패: ${filePath}\n${err instanceof Error ? err.message : err}`);
  }
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown, filePath: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`설정 파일 검증 실패: ${filePath}\n${details}`);
  }
  return result.data;
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}

export interface CodeEntry {
  code: string;
  name: string;
  /**
   * productCodes 전용. true면 이 품목만으로는 수집하지 않고 제목 키워드가 같이 걸려야 한다.
   * 쓰임새가 넓은 품목(영상정보디스플레이장치 — 보안 관제실·상황실 모니터 구매에도 쓰인다)용.
   */
  requiresKeyword?: boolean;
}

export interface AppConfig {
  keywords: string[];
  /** 제목에 있으면 무조건 제외 */
  excludeKeywords: string[];
  /** 제목에 있으면 제외하되, 제작 신호(makeSignals)가 함께 있으면 통과 — "전시연출 및 제작·설치" 같은 본업 공고를 살린다 */
  softExcludeKeywords?: string[];
  makeSignals?: string[];
  /** 제외 키워드가 이 말 안에만 들어 있으면 걸지 않는다 — 예: "건축"은 "실내건축"에서는 무시 */
  excludeKeywordExceptions?: Record<string, string[]>;
  minBudgetAmount: number | null;
  businessTypes: BusinessType[];
  allowedBidMethods: BidMethodCategory[];
  productCodes: CodeEntry[];
  industryCodes: CodeEntry[];
  recipients: string[];
  heldProducts: CodeEntry[];
  heldIndustries: CodeEntry[];
}

let cached: AppConfig | null = null;
/** 캐시를 만들 때의 설정 파일 경로·수정 시각. 달라지면 다시 읽는다. */
let cachedSignature = "";

/**
 * 설정 파일들의 경로와 수정 시각을 이어 붙인 값.
 * 웹 UI·텔레그램 봇처럼 계속 떠 있는 프로세스에서 keywords.json을 고치면 재시작 없이 다음 조회부터
 * 반영돼야 한다 — 예전에는 처음 읽은 설정을 끝까지 들고 있어서, 제외 키워드를 넣어도 서버를 다시
 * 켜기 전까지 목록에 그대로 나왔다 (2026-09-30 '건설공사').
 */
function configSignature(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        return `${p}@${statSync(p).mtimeMs}`;
      } catch {
        return `${p}@missing`;
      }
    })
    .join("|");
}

export function loadAppConfig(): AppConfig {
  const configDir = resolveConfigDir();
  const keywordsPath = path.join(configDir, "keywords.json");
  const codesPath = path.join(configDir, "codes.json");
  const recipientsPath = path.join(configDir, "recipients.json");
  const heldQualificationsPath = path.join(configDir, "held-qualifications.json");

  const signature = configSignature([keywordsPath, codesPath, recipientsPath, heldQualificationsPath]);
  if (cached && signature === cachedSignature) return cached;

  const keywordsData = parseOrThrow(keywordsFileSchema, readJsonFile(keywordsPath), keywordsPath);
  const codesData = parseOrThrow(codesFileSchema, readJsonFile(codesPath), codesPath);
  const recipientsData = parseOrThrow(recipientsFileSchema, readJsonFile(recipientsPath), recipientsPath);
  const heldQualificationsData = parseOrThrow(
    heldQualificationsFileSchema,
    readJsonFile(heldQualificationsPath),
    heldQualificationsPath
  );

  const dupKeywords = findDuplicates(keywordsData.keywords);
  if (dupKeywords.length > 0) {
    throw new ConfigError(`keywords.json에 중복된 키워드가 있습니다: ${dupKeywords.join(", ")}`);
  }

  const dupExcludeKeywords = findDuplicates([...keywordsData.excludeKeywords, ...keywordsData.softExcludeKeywords]);
  if (dupExcludeKeywords.length > 0) {
    throw new ConfigError(`keywords.json excludeKeywords에 중복된 키워드가 있습니다: ${dupExcludeKeywords.join(", ")}`);
  }

  const dupProductCodes = findDuplicates(codesData.productCodes.map((c) => c.code));
  if (dupProductCodes.length > 0) {
    throw new ConfigError(`codes.json productCodes에 중복된 코드가 있습니다: ${dupProductCodes.join(", ")}`);
  }

  const dupIndustryCodes = findDuplicates(codesData.industryCodes.map((c) => c.code));
  if (dupIndustryCodes.length > 0) {
    throw new ConfigError(`codes.json industryCodes에 중복된 코드가 있습니다: ${dupIndustryCodes.join(", ")}`);
  }

  const dupRecipients = findDuplicates(recipientsData.recipients.map((r) => r.toLowerCase()));
  if (dupRecipients.length > 0) {
    throw new ConfigError(`recipients.json에 중복된 이메일이 있습니다: ${dupRecipients.join(", ")}`);
  }

  const dupHeldProducts = findDuplicates(heldQualificationsData.heldProducts.map((c) => c.code));
  if (dupHeldProducts.length > 0) {
    throw new ConfigError(`held-qualifications.json heldProducts에 중복된 코드가 있습니다: ${dupHeldProducts.join(", ")}`);
  }

  const dupHeldIndustries = findDuplicates(heldQualificationsData.heldIndustries.map((c) => c.code));
  if (dupHeldIndustries.length > 0) {
    throw new ConfigError(`held-qualifications.json heldIndustries에 중복된 코드가 있습니다: ${dupHeldIndustries.join(", ")}`);
  }

  cached = {
    keywords: keywordsData.keywords,
    excludeKeywords: keywordsData.excludeKeywords,
    softExcludeKeywords: keywordsData.softExcludeKeywords,
    makeSignals: keywordsData.makeSignals,
    excludeKeywordExceptions: keywordsData.excludeKeywordExceptions,
    minBudgetAmount: keywordsData.minBudgetAmount,
    businessTypes: keywordsData.businessTypes,
    allowedBidMethods: keywordsData.allowedBidMethods,
    productCodes: codesData.productCodes,
    industryCodes: codesData.industryCodes,
    recipients: recipientsData.recipients,
    heldProducts: heldQualificationsData.heldProducts,
    heldIndustries: heldQualificationsData.heldIndustries,
  };
  cachedSignature = signature;
  return cached;
}

/** 테스트에서 캐시를 리셋하기 위한 헬퍼 */
export function _resetAppConfigCacheForTests(): void {
  cached = null;
  cachedSignature = "";
}
