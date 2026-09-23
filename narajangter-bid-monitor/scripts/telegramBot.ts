/**
 * 텔레그램에서 슬래시 명령으로 직접 조회하는 대화형 봇.
 *
 *   npm run bot
 *
 * 텔레그램은 봇에게 메시지를 "밀어주지" 않는다. 받으려면 둘 중 하나가 필요하다:
 *   (1) 웹훅 — 공개 서버와 HTTPS 도메인이 있어야 함
 *   (2) 롱 폴링 — 상시 떠 있는 프로세스가 계속 물어봄  ← 이 스크립트
 *
 * GitHub Actions는 정해진 시각에만 깨므로 (1)(2) 다 불가능하다. 그래서 이 봇은
 * **테스트 기간 동안 본인 PC에서 띄워두는 용도**다. 이 창을 닫으면 명령도 멈춘다.
 * 정기 자동 발송(GitHub Actions)은 이 봇과 무관하게 계속 동작한다.
 *
 * ⚠️ 텔레그램은 한 봇에 대해 동시에 하나의 getUpdates만 허용한다.
 *    이 봇이 떠 있는 동안 npm run test:telegram 을 돌리면 서로 업데이트를 뺏는다.
 */
import "dotenv/config";
import { loadEnv } from "../src/config/env.js";
import { loadAppConfig } from "../src/config/loadJsonConfig.js";
import { collectReportInput } from "../src/pipeline.js";
import { buildReport, type ReportInput } from "../src/report/buildReport.js";
import { formatAge, loadReportInput, saveReportInput } from "../src/cache/reportCache.js";
import { buildTelegramMessages } from "../src/notify/telegramMessage.js";
import { sendTelegramReport } from "../src/notify/telegram.js";
import { toErrorMessage } from "../src/errors.js";
import { redactSecrets } from "../src/redact.js";
import { logger } from "../src/logger.js";

const TELEGRAM_API = "https://api.telegram.org";
/** 롱 폴링 대기 시간(초). 이 시간 동안 새 메시지가 없으면 빈 응답이 온다. */
const POLL_TIMEOUT_SEC = 30;

const botToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const allowedChatIds = new Set(
  (process.env.TELEGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "")
);

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function mask(value: unknown): string {
  return redactSecrets(typeof value === "string" ? value : toErrorMessage(value), [botToken]);
}

async function api(method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/${method}`, {
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    // 롱 폴링은 서버가 최대 POLL_TIMEOUT_SEC 동안 응답을 붙들고 있으므로 여유를 둔다.
    signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 15) * 1000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`텔레그램 ${method} 실패 (HTTP ${res.status}): ${mask(text.slice(0, 300))}`);
  return JSON.parse(text);
}

async function reply(chatId: string, text: string): Promise<void> {
  await api("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

/** 나중에 수정할 메시지를 보내고 message_id를 돌려받는다. */
async function replyReturningId(chatId: string, text: string): Promise<number> {
  const res = await api("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  return res.result.message_id as number;
}

/**
 * 진행 표시용 메시지 수정.
 * 내용이 직전과 같으면 텔레그램이 400(message is not modified)을 내는데, 그건 오류가
 * 아니라 "바뀐 게 없다"는 뜻이라 무시한다. 진행 표시가 실패해도 조회는 계속돼야 한다.
 */
async function editMessage(chatId: string, messageId: number, text: string): Promise<void> {
  try {
    await api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    logger.debug("진행 메시지 수정 실패 (무시)", { error: mask(err) });
  }
}

const HELP = [
  "<b>사용 가능한 명령</b>",
  "",
  "/report — 결과 보기 (즉시 · 미리 받아둔 자료)",
  "/report 3 — 최근 3일치만",
  "/refresh — 나라장터에서 지금 다시 받아오기 (40초)",
  "/status — 설정 상태와 자료 수집 시각",
  "/help — 이 도움말",
  "",
  "<i>조회만 합니다 — 이메일 발송이나 시트 기록은 하지 않습니다.</i>",
].join("\n");

/** 백그라운드 수집 주기. 이 간격마다 미리 받아둬서 /report가 기다리지 않게 한다. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 동시에 두 번 수집하지 않도록 진행 중인 작업을 붙들어 둔다.
 * 자동 갱신 도중에 /refresh가 들어오면 새로 시작하지 않고 같은 작업을 기다린다.
 */
const inFlight = new Map<number, Promise<ReportInput>>();

function parseDays(arg: string | undefined, fallback: number): number | "invalid" {
  if (!arg) return fallback;
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > 90) return "invalid";
  return n;
}

/** 나라장터에서 실제로 받아와 캐시에 저장한다. 같은 기간의 중복 수집은 합쳐진다. */
function collectAndCache(
  lookbackDays: number,
  onProgress?: (message: string) => Promise<void>
): Promise<ReportInput> {
  const existing = inFlight.get(lookbackDays);
  if (existing) return existing;

  const env = loadEnv();
  const appConfig = loadAppConfig();

  const task = (async () => {
    try {
      const input = await collectReportInput(env, appConfig, { lookbackDays, onProgress });
      await saveReportInput(input, lookbackDays);
      return input;
    } finally {
      inFlight.delete(lookbackDays);
    }
  })();

  inFlight.set(lookbackDays, task);
  return task;
}

async function deliverReport(chatId: string, input: ReportInput, note: string): Promise<void> {
  const report = buildReport(input);
  await reply(chatId, note);
  // 요청한 대화로만 보낸다 — 테스트하려고 친 명령이 팀 전체에 울리면 안 된다.
  await sendTelegramReport(input, {
    botToken,
    chatIds: [chatId],
    attachHtml: report.totalMatchCount > 0 ? report.html : undefined,
  });
}

/**
 * /report [일수] — 미리 받아둔 자료로 **즉시** 답한다.
 *
 * 나라장터에서 매번 새로 받으면 40초가 걸린다. 공고는 초 단위로 바뀌는 자료가 아니라,
 * 몇 분 전 기준이어도 판단에는 지장이 없다. 대신 언제 받은 자료인지는 반드시 같이 보여준다 —
 * 오래된 자료를 최신인 것처럼 보여주는 게 느린 것보다 나쁘다.
 */
async function handleReport(chatId: string, arg: string | undefined): Promise<void> {
  const env = loadEnv();
  const days = parseDays(arg, env.lookbackDays);
  if (days === "invalid") {
    await reply(chatId, "조회 기간은 1~90 사이의 정수로 넣어주세요. 예: <code>/report 3</code>");
    return;
  }

  const cached = await loadReportInput(days);
  if (cached) {
    await deliverReport(
      chatId,
      cached.input,
      `📦 <b>${formatAge(cached.ageMs)}</b> 받아둔 자료입니다. 지금 다시 받으려면 /refresh`
    );
    return;
  }

  // 캐시가 아직 없을 때만(봇을 막 켠 직후 등) 직접 받아온다.
  await reply(chatId, `아직 받아둔 자료가 없어 지금 받아옵니다. 40초쯤 걸립니다…`);
  await handleRefresh(chatId, arg);
}

/** /refresh — 나라장터에서 지금 다시 받아온다. */
async function handleRefresh(chatId: string, arg: string | undefined): Promise<void> {
  const env = loadEnv();
  const days = parseDays(arg, env.lookbackDays);
  if (days === "invalid") {
    await reply(chatId, "조회 기간은 1~90 사이의 정수로 넣어주세요. 예: <code>/refresh 3</code>");
    return;
  }

  const started = Date.now();
  const progressMessageId = await replyReturningId(chatId, `🔎 최근 ${days}일치 받아오는 중…`);
  const onProgress = async (message: string): Promise<void> => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    await editMessage(chatId, progressMessageId, `🔎 최근 ${days}일치 · ${message} (${elapsed}초)`);
  };

  const input = await collectAndCache(days, onProgress);
  const elapsed = Math.round((Date.now() - started) / 1000);
  await editMessage(chatId, progressMessageId, `✅ 최신 자료로 갱신했습니다 (${elapsed}초)`);

  await deliverReport(chatId, input, "🆕 방금 받아온 최신 자료입니다.");
}

async function handleStatus(chatId: string): Promise<void> {
  const env = loadEnv();
  const appConfig = loadAppConfig();
  const on = (v: boolean) => (v ? "✅ 켜짐" : "⬜ 꺼짐");

  const cached = await loadReportInput(env.lookbackDays);
  const cachedAt = cached ? formatAge(cached.ageMs) + " (" + cached.savedAt.toLocaleString("ko-KR") + ")" : "아직 없음";

  await reply(
    chatId,
    [
      "<b>현재 설정</b>",
      "",
      `기본 조회 기간: ${env.lookbackDays}일`,
      `최소 예산: ${
        appConfig.minBudgetAmount === null
          ? "제한 없음"
          : `${appConfig.minBudgetAmount.toLocaleString("ko-KR")}원`
      }`,
      `키워드 ${appConfig.keywords.length}개 · 제외 키워드 ${appConfig.excludeKeywords.length}개`,
      `품목코드 ${appConfig.productCodes.length}개 · 업종코드 ${appConfig.industryCodes.length}개`,
      "",
      `텔레그램 알림: ${on(env.telegramEnabled)} (수신 ${env.telegramChatIds.length}곳)`,
      `구글 시트 기록: ${on(env.feedbackSheetEnabled)}`,
      `이메일 수신자: ${appConfig.recipients.length}명`,
      "",
      `자료 수집 시각: ${cachedAt}`,
      "",
      `<i>이 대화 chat_id: <code>${chatId}</code></i>`,
    ].join("\n")
  );
}

async function handleUpdate(update: any): Promise<void> {
  const message = update.message ?? update.edited_message;
  const chatId = message?.chat?.id;
  const text: string | undefined = message?.text;
  if (chatId === undefined || !text) return;

  const chatIdStr = String(chatId);

  // 아무나 명령을 못 쓰게 막는다. 열어두면 모르는 사람이 우리 data.go.kr API 키로
  // 조회를 반복시킬 수 있다.
  if (!allowedChatIds.has(chatIdStr)) {
    logger.warn("허용되지 않은 대화의 명령 무시", { chatId: chatIdStr });
    await reply(chatIdStr, "이 봇은 지정된 대화에서만 사용할 수 있습니다.");
    return;
  }

  // 그룹에서는 "/report@봇아이디 3" 형태로 온다.
  const [rawCommand, ...args] = text.trim().split(/\s+/);
  if (!rawCommand?.startsWith("/")) return;
  const command = rawCommand.split("@")[0]!.toLowerCase();

  logger.info("명령 수신", { chatId: chatIdStr, command });

  try {
    switch (command) {
      case "/report":
        await handleReport(chatIdStr, args[0]);
        break;
      case "/refresh":
        await handleRefresh(chatIdStr, args[0]);
        break;
      case "/status":
        await handleStatus(chatIdStr);
        break;
      case "/start":
      case "/help":
        await reply(chatIdStr, HELP);
        break;
      default:
        await reply(chatIdStr, `모르는 명령입니다: <code>${command}</code>\n\n${HELP}`);
    }
  } catch (err) {
    const detail = mask(err);
    logger.error("명령 처리 실패", { command, error: detail });
    await reply(chatIdStr, `⚠️ 처리 중 오류가 발생했습니다.\n\n<pre>${detail.slice(0, 1500)}</pre>`);
  }
}

async function main(): Promise<void> {
  if (!botToken) fail("TELEGRAM_BOT_TOKEN이 비어 있습니다.");
  if (allowedChatIds.size === 0) {
    fail("TELEGRAM_CHAT_IDS가 비어 있습니다. npm run test:telegram 으로 chat_id를 먼저 확인하세요.");
  }

  const me = await api("getMe");
  if (!me.ok) fail("봇 토큰이 올바르지 않습니다.");

  const webhook = await api("getWebhookInfo");
  if (webhook.result?.url) {
    fail(`웹훅이 걸려 있어 롱 폴링을 쓸 수 없습니다 (${webhook.result.url}). deleteWebhook으로 해제하세요.`);
  }

  // 텔레그램 입력창에 "/" 를 쳤을 때 뜨는 명령 목록을 등록한다.
  await api("setMyCommands", {
    commands: [
      { command: "report", description: "결과 보기 (즉시)" },
      { command: "refresh", description: "나라장터에서 지금 다시 받아오기" },
      { command: "status", description: "현재 설정 상태 확인" },
      { command: "help", description: "도움말" },
    ],
  });

  console.log(`\n✓ @${me.result.username} 대기 중 — 텔레그램에서 /report 를 보내보세요.`);
  console.log(`  허용된 대화: ${[...allowedChatIds].join(", ")}`);
  console.log("  종료: Ctrl+C\n");

  // 켜자마자 한 번 받아두고 이후 주기적으로 갱신한다.
  // 이렇게 미리 받아둬야 /report가 기다리지 않는다.
  const warm = async (): Promise<void> => {
    try {
      const env = loadEnv();
      await collectAndCache(env.lookbackDays);
      logger.info("백그라운드 수집 완료", { lookbackDays: env.lookbackDays });
    } catch (err) {
      logger.warn("백그라운드 수집 실패 (다음 주기에 재시도)", { error: mask(err) });
    }
  };
  void warm();
  const refreshTimer = setInterval(() => void warm(), REFRESH_INTERVAL_MS);
  refreshTimer.unref();

  let running = true;
  process.on("SIGINT", () => {
    console.log("\n봇을 종료합니다.");
    running = false;
    process.exit(0);
  });

  // offset은 "여기까지 처리했다"는 표시다. 넘기지 않으면 같은 명령을 계속 다시 받는다.
  let offset: number | undefined;
  while (running) {
    try {
      const res = await api(
        `getUpdates?timeout=${POLL_TIMEOUT_SEC}${offset !== undefined ? `&offset=${offset}` : ""}`
      );
      for (const update of res.result ?? []) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (err) {
      // 타임아웃은 롱 폴링의 정상 동작이라 조용히 넘긴다.
      const detail = mask(err);
      if (!/timed?\s?out|aborted/i.test(detail)) {
        logger.error("폴링 오류 — 5초 후 재시도", { error: detail });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}

main().catch((err) => fail(mask(err)));
