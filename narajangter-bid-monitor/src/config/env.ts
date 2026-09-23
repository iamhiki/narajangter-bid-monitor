import "dotenv/config";
import { ConfigError } from "../errors.js";

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;
  throw new ConfigError(`불리언 값이 올바르지 않습니다: "${raw}" (true/false 사용)`);
}

function parseInt_(raw: string | undefined, fallback: number, key: string, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`${key}는 정수여야 합니다. 현재 값: "${raw}"`);
  }
  if (n < min || n > max) {
    throw new ConfigError(`${key}는 ${min}~${max} 범위여야 합니다. 현재 값: ${n}`);
  }
  return n;
}

function parseLogLevel(raw: string | undefined): "debug" | "info" | "warn" | "error" {
  const v = (raw ?? "info").trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  throw new ConfigError(`LOG_LEVEL은 debug|info|warn|error 중 하나여야 합니다. 현재 값: "${raw}"`);
}

export interface Env {
  naraBidServiceKey: string;
  naraPrestdServiceKey: string;
  naraBidBaseUrl?: string;
  naraPrestdBaseUrl?: string;

  lookbackDays: number;
  apiNumOfRows: number;
  apiMaxPages: number;
  apiTimeoutMs: number;
  apiMaxRetries: number;
  apiRetryDelayMs: number;
  apiRequestIntervalMs: number;
  apiPageConcurrency: number;

  sendEmptyReport: boolean;
  alertEmailOnFailure: boolean;
  dryRun: boolean;
  logLevel: "debug" | "info" | "warn" | "error";

  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom: string;

  /** 텔레그램 봇 토큰. 토큰과 chat_id가 모두 있어야 텔레그램 발송이 켜진다. */
  telegramBotToken?: string;
  telegramChatIds: string[];
  telegramEnabled: boolean;

  /** 구글 서비스 계정 키 JSON 전문. 시트 ID와 함께 있어야 피드백 시트 기록이 켜진다. */
  googleServiceAccountJson?: string;
  feedbackSheetId?: string;
  feedbackSheetName: string;
  feedbackSheetEnabled: boolean;
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  const e = process.env;
  const errors: string[] = [];

  const dryRun = parseBool(e.DRY_RUN, false);

  const naraBidServiceKey = (e.NARA_BID_SERVICE_KEY ?? "").trim();
  if (!dryRun && !naraBidServiceKey) {
    errors.push("NARA_BID_SERVICE_KEY가 설정되지 않았습니다. (.env 파일을 확인하거나 DRY_RUN=true로 실행하세요)");
  }
  const naraPrestdServiceKey = (e.NARA_PRESTD_SERVICE_KEY ?? "").trim() || naraBidServiceKey;

  const smtpHost = e.SMTP_HOST?.trim() || undefined;
  const smtpUser = e.SMTP_USER?.trim() || undefined;
  const smtpPass = e.SMTP_PASS || undefined;
  if (!dryRun) {
    if (!smtpHost) errors.push("SMTP_HOST가 설정되지 않았습니다.");
    if (!smtpUser) errors.push("SMTP_USER가 설정되지 않았습니다.");
    if (!smtpPass) errors.push("SMTP_PASS가 설정되지 않았습니다.");
  }

  const telegramBotToken = e.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  const telegramChatIds = (e.TELEGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  // 둘 중 하나만 채워져 있으면 거의 확실히 설정 실수다 - 조용히 발송을 건너뛰지 않고 즉시 알려준다.
  if (telegramBotToken && telegramChatIds.length === 0) {
    errors.push("TELEGRAM_BOT_TOKEN은 있는데 TELEGRAM_CHAT_IDS가 비어 있습니다. (쉼표로 구분해 하나 이상 넣으세요)");
  }
  if (!telegramBotToken && telegramChatIds.length > 0) {
    errors.push("TELEGRAM_CHAT_IDS는 있는데 TELEGRAM_BOT_TOKEN이 비어 있습니다.");
  }
  // 토큰과 수신자가 모두 있으면 자동으로 켜진다. TELEGRAM_ENABLED=false로 명시적으로 끌 수 있다.
  const telegramEnabled =
    parseBool(e.TELEGRAM_ENABLED, true) && Boolean(telegramBotToken) && telegramChatIds.length > 0;

  const googleServiceAccountJson = e.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || undefined;
  const feedbackSheetId = e.FEEDBACK_SHEET_ID?.trim() || undefined;
  const feedbackSheetName = e.FEEDBACK_SHEET_NAME?.trim() || "피드백";
  // 텔레그램과 같은 규칙: 둘 중 하나만 채워져 있으면 설정 실수이므로 조용히 넘어가지 않는다.
  if (googleServiceAccountJson && !feedbackSheetId) {
    errors.push("GOOGLE_SERVICE_ACCOUNT_JSON은 있는데 FEEDBACK_SHEET_ID가 비어 있습니다.");
  }
  if (!googleServiceAccountJson && feedbackSheetId) {
    errors.push("FEEDBACK_SHEET_ID는 있는데 GOOGLE_SERVICE_ACCOUNT_JSON이 비어 있습니다.");
  }
  const feedbackSheetEnabled =
    parseBool(e.FEEDBACK_SHEET_ENABLED, true) &&
    Boolean(googleServiceAccountJson) &&
    Boolean(feedbackSheetId);

  // 기본값은 각 parseInt_ 호출의 두 번째 인자 한 곳에만 정의한다 (여기 선언은 타입만 확보하는 용도).
  // try 블록이 끝까지 성공해야만(=errors가 비어야만) 아래 cached 조립에서 실제로 쓰이므로,
  // 이 시점의 초기값 자체는 의미가 없다 - 두 곳에 기본값을 따로 적어두면 한쪽만 고치는 실수가 나기 쉽다.
  // 아래 값들은 try 블록에서 항상 채워지고, 채우다 실패하면 errors에 쌓여 곧바로 throw 되어
  // 절대 읽히지 않는다 (TS는 이 제어흐름을 못 따라가므로 definite assignment assertion 사용).
  let lookbackDays!: number;
  let apiNumOfRows!: number;
  let apiMaxPages!: number;
  let apiTimeoutMs!: number;
  let apiMaxRetries!: number;
  let apiRetryDelayMs!: number;
  let apiRequestIntervalMs!: number;
  let apiPageConcurrency!: number;
  let smtpPort!: number;
  let logLevel!: Env["logLevel"];

  try {
    lookbackDays = parseInt_(e.LOOKBACK_DAYS, 7, "LOOKBACK_DAYS", 1, 90);
    // 999가 API 허용 상한이다. 500이면 페이지 수가 두 배가 되고 그만큼 왕복이 늘어난다
    // (2026-09-17 실측: 500 -> 999로 올려 전체 소요 23초 -> 14초, 수집 건수는 동일).
    apiNumOfRows = parseInt_(e.API_NUM_OF_ROWS, 999, "API_NUM_OF_ROWS", 1, 999);
    apiMaxPages = parseInt_(e.API_MAX_PAGES, 40, "API_MAX_PAGES", 1, 500);
    apiTimeoutMs = parseInt_(e.API_TIMEOUT_MS, 30000, "API_TIMEOUT_MS", 1000, 120000);
    apiMaxRetries = parseInt_(e.API_MAX_RETRIES, 4, "API_MAX_RETRIES", 0, 10);
    apiRetryDelayMs = parseInt_(e.API_RETRY_DELAY_MS, 1500, "API_RETRY_DELAY_MS", 0, 60000);
    apiRequestIntervalMs = parseInt_(e.API_REQUEST_INTERVAL_MS, 300, "API_REQUEST_INTERVAL_MS", 0, 60000);
    // data.go.kr TPS 제한이 있어 무한정 올릴 수 없다. 1이면 예전처럼 한 장씩 순차 조회.
    apiPageConcurrency = parseInt_(e.API_PAGE_CONCURRENCY, 4, "API_PAGE_CONCURRENCY", 1, 16);
    smtpPort = parseInt_(e.SMTP_PORT, 587, "SMTP_PORT", 1, 65535);
    logLevel = parseLogLevel(e.LOG_LEVEL);
  } catch (err) {
    errors.push(err instanceof ConfigError ? err.message : String(err));
  }

  if (errors.length > 0) {
    throw new ConfigError(`환경변수 검증 실패:\n${errors.map((m) => `  - ${m}`).join("\n")}`);
  }

  const smtpFrom = e.SMTP_FROM?.trim() || smtpUser || "";

  cached = {
    naraBidServiceKey,
    naraPrestdServiceKey,
    naraBidBaseUrl: e.NARA_BID_BASE_URL?.trim() || undefined,
    naraPrestdBaseUrl: e.NARA_PRESTD_BASE_URL?.trim() || undefined,

    lookbackDays,
    apiNumOfRows,
    apiMaxPages,
    apiTimeoutMs,
    apiMaxRetries,
    apiRetryDelayMs,
    apiRequestIntervalMs,
    apiPageConcurrency,

    sendEmptyReport: parseBool(e.SEND_EMPTY_REPORT, true),
    alertEmailOnFailure: parseBool(e.ALERT_EMAIL_ON_FAILURE, true),
    dryRun,
    logLevel,

    smtpHost,
    smtpPort,
    smtpSecure: parseBool(e.SMTP_SECURE, false),
    smtpUser,
    smtpPass,
    smtpFrom,

    telegramBotToken,
    telegramChatIds,
    telegramEnabled,

    googleServiceAccountJson,
    feedbackSheetId,
    feedbackSheetName,
    feedbackSheetEnabled,
  };

  return cached;
}

/** 테스트에서 캐시를 리셋하기 위한 헬퍼 */
export function _resetEnvCacheForTests(): void {
  cached = null;
}
