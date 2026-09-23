import { TelegramError, toErrorMessage } from "../errors.js";
import { logger } from "../logger.js";
import { redactSecrets } from "../redact.js";
import type { ReportInput } from "../report/buildReport.js";
import {
  buildDocumentCaption,
  buildDocumentFilename,
  buildTelegramFailureMessage,
  buildTelegramMessages,
} from "./telegramMessage.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramSendOptions {
  botToken: string;
  chatIds: string[];
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  /**
   * 같은 채팅으로 연속 발송할 때의 간격(ms).
   * 텔레그램 공식 권장치는 "동일 채팅 기준 초당 1건 이하"이며, 초과하면 429가 돌아온다.
   */
  messageIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * 봇 토큰이 URL 경로에 들어가는 API라, 오류 메시지에 URL을 절대 넣지 않는다.
 * 응답 본문에도 토큰이 섞여 들어올 여지를 남기지 않도록 redactSecrets를 한 번 더 통과시킨다.
 */
async function sendOnce(
  botToken: string,
  chatId: string,
  text: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        // 공고 링크마다 미리보기 카드가 붙으면 메시지가 지나치게 길어져서 끈다.
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    const raw = await res.text();
    const safeRaw = redactSecrets(raw.slice(0, 500), [botToken]);

    let parsed: TelegramApiResponse | null = null;
    try {
      parsed = JSON.parse(raw) as TelegramApiResponse;
    } catch {
      // 텔레그램이 JSON이 아닌 응답(프록시 오류 페이지 등)을 준 경우 — 아래에서 원문으로 보고한다.
    }

    if (!res.ok || !parsed?.ok) {
      const retryAfter = parsed?.parameters?.retry_after;
      const description = parsed?.description ?? safeRaw;
      const err = new TelegramError(
        `텔레그램 발송 실패 (chat_id=${chatId}, HTTP ${res.status}): ${description}`
      );
      // 429의 retry_after는 재시도 대기시간 계산에 쓰려고 에러에 얹어 둔다.
      (err as TelegramError & { retryAfterMs?: number }).retryAfterMs =
        typeof retryAfter === "number" ? retryAfter * 1000 : undefined;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function sendWithRetry(
  botToken: string,
  chatId: string,
  text: string,
  timeoutMs: number,
  maxRetries: number,
  retryDelayMs: number
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await sendOnce(botToken, chatId, text, timeoutMs);
      return;
    } catch (err) {
      lastError = err;
      logger.warn(`텔레그램 발송 실패 (${attempt + 1}/${maxRetries + 1}시도)`, {
        chatId,
        error: redactSecrets(toErrorMessage(err), [botToken]),
      });
      if (attempt === maxRetries) break;

      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
      await sleep(retryAfterMs ?? retryDelayMs * 2 ** attempt);
    }
  }

  throw new TelegramError(
    `텔레그램 발송 최종 실패 (chat_id=${chatId}, ${maxRetries + 1}회 시도): ${redactSecrets(
      toErrorMessage(lastError),
      [botToken]
    )}`,
    lastError
  );
}

/** 여러 메시지를 여러 채팅에 순차 발송한다. 한 채팅이 실패해도 나머지 채팅은 계속 시도한다. */
async function sendMessages(messages: string[], options: TelegramSendOptions): Promise<void> {
  const {
    botToken,
    chatIds,
    timeoutMs = 15000,
    maxRetries = 2,
    retryDelayMs = 1000,
    messageIntervalMs = 1100,
  } = options;

  if (chatIds.length === 0) {
    throw new TelegramError("텔레그램 수신 chat_id가 없습니다 (TELEGRAM_CHAT_IDS 확인)");
  }

  const failures: string[] = [];

  for (const chatId of chatIds) {
    try {
      for (let i = 0; i < messages.length; i++) {
        if (i > 0 && messageIntervalMs > 0) await sleep(messageIntervalMs);
        await sendWithRetry(botToken, chatId, messages[i]!, timeoutMs, maxRetries, retryDelayMs);
      }
    } catch (err) {
      failures.push(redactSecrets(toErrorMessage(err), [botToken]));
    }
  }

  if (failures.length === chatIds.length) {
    throw new TelegramError(`모든 텔레그램 수신자에게 발송 실패:\n${failures.join("\n")}`);
  }
  if (failures.length > 0) {
    logger.warn("일부 텔레그램 수신자에게 발송 실패", { 실패수: failures.length, 전체: chatIds.length });
  }
}

/**
 * HTML 보고서를 파일로 첨부해 보낸다.
 *
 * 텍스트 메시지는 4096자 제한 때문에 요약일 수밖에 없어서, 전체 내용은 파일로 보낸다.
 * 봇의 파일 업로드 상한은 50MB라 우리 리포트(수십 KB)는 여유가 많다.
 */
async function sendDocument(
  chatId: string,
  doc: { filename: string; content: string; caption?: string },
  botToken: string,
  timeoutMs: number
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", new Blob([doc.content], { type: "text/html" }), doc.filename);
  if (doc.caption) {
    form.append("caption", doc.caption);
    form.append("parse_mode", "HTML");
  }

  const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new TelegramError(
      `첨부 파일 발송 실패 (chat_id=${chatId}, HTTP ${res.status}): ${redactSecrets(raw.slice(0, 300), [botToken])}`
    );
  }
}

export async function sendTelegramReport(
  input: ReportInput,
  options: TelegramSendOptions & { attachHtml?: string }
): Promise<void> {
  const messages = buildTelegramMessages(input);
  await sendMessages(messages, options);

  // 첨부는 본문이 이미 나간 뒤에 시도한다. 파일이 실패해도 요약은 이미 도착해 있어야 한다.
  let attachedTo = 0;
  if (options.attachHtml) {
    const filename = buildDocumentFilename(input);
    const caption = buildDocumentCaption(input);
    for (const chatId of options.chatIds) {
      try {
        await sendDocument(
          chatId,
          { filename, content: options.attachHtml, caption },
          options.botToken,
          options.timeoutMs ?? 30000
        );
        attachedTo += 1;
      } catch (err) {
        logger.warn("첨부 HTML 발송 실패 (요약 메시지는 이미 발송됨)", {
          chatId,
          error: redactSecrets(toErrorMessage(err), [options.botToken]),
        });
      }
    }
  }

  logger.info("텔레그램 리포트 발송 완료", {
    chatIds: options.chatIds,
    메시지수: messages.length,
    첨부발송: attachedTo,
  });
}

export async function sendTelegramFailureAlert(
  errorMessage: string,
  occurredAt: Date,
  options: TelegramSendOptions
): Promise<void> {
  await sendMessages([buildTelegramFailureMessage(errorMessage, occurredAt)], {
    ...options,
    maxRetries: options.maxRetries ?? 1,
  });
  logger.info("텔레그램 실패 알림 발송 완료", { chatIds: options.chatIds });
}
