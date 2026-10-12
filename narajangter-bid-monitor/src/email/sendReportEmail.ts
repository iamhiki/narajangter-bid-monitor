import type { Transporter } from "nodemailer";
import { EmailError, toErrorMessage } from "../errors.js";
import { logger } from "../logger.js";
import type { ReportOutput } from "../report/buildReport.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendOptions {
  transporter: Transporter;
  from: string;
  recipients: string[];
  maxRetries?: number;
  retryDelayMs?: number;
}

async function sendWithRetry(
  transporter: Transporter,
  mail: { from: string; to: string[]; subject: string; html: string; text: string },
  maxRetries: number,
  retryDelayMs: number
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await transporter.sendMail(mail);
      return;
    } catch (err) {
      lastError = err;
      logger.warn(`이메일 발송 실패 (${attempt + 1}/${maxRetries + 1}시도)`, { error: toErrorMessage(err) });
      if (attempt < maxRetries) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
  }
  throw new EmailError(`이메일 발송 최종 실패 (${maxRetries + 1}회 시도)`, lastError);
}

export async function sendReportEmail(report: ReportOutput, options: SendOptions): Promise<void> {
  if (options.recipients.length === 0) {
    throw new EmailError("수신자가 없습니다 (config/recipients.json 확인)");
  }

  await sendWithRetry(
    options.transporter,
    {
      from: options.from,
      to: options.recipients,
      subject: report.subject,
      html: report.html,
      text: report.text,
    },
    options.maxRetries ?? 3,
    options.retryDelayMs ?? 1000
  );

  logger.info("리포트 이메일 발송 완료", { recipients: options.recipients, totalMatchCount: report.totalMatchCount });
}
