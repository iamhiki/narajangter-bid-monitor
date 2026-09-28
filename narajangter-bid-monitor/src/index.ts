import { loadEnv, type Env } from "./config/env.js";
import { loadAppConfig } from "./config/loadJsonConfig.js";
import { collectReportInput, hasFetchFailures } from "./pipeline.js";
import { buildReport, type ReportInput, type ReportSource } from "./report/buildReport.js";
import { buildTelegramMessages } from "./notify/telegramMessage.js";
import { sendTelegramFailureAlert, sendTelegramReport } from "./notify/telegram.js";
import { appendMatchesToFeedbackSheet } from "./sheets/feedbackSheet.js";
import { saveReportToDisk } from "./report/saveReport.js";
import { createTransporter, verifyTransporter } from "./email/mailer.js";
import { sendFailureAlertEmail, sendReportEmail } from "./email/sendReportEmail.js";
import type { MatchedNotice } from "./matching/types.js";
import {
  isNotified,
  loadNotifiedState,
  markNotified,
  saveNotifiedState,
  shouldSendFailureAlert,
  type NotifiedState,
} from "./state/notifiedStore.js";
import { toErrorMessage } from "./errors.js";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

/**
 * 두 가지 모드로 돈다 (RUN_MODE).
 *
 *   weekly — 매주 한 번, 기간 전체를 모아 이메일 리포트를 보낸다.
 *   hourly — 매시간, 새로 나온 공고만 골라 텔레그램으로 바로 알린다.
 *
 * 텔레그램은 매시간 알림이 맡고 이메일은 주간 요약을 맡는다. 주간 실행에서 텔레그램 보고서까지
 * 보내면 이미 받은 공고를 한 번 더 받게 되므로 보내지 않는다.
 */
async function run(): Promise<number> {
  let env: Env | undefined;
  let state: NotifiedState | undefined;

  try {
    env = loadEnv();
    const appConfig = loadAppConfig();
    const now = new Date();
    if (env.runMode === "hourly") state = loadNotifiedState(env.notifiedStatePath);

    // ①수집~③필터링은 텔레그램 수동 조회(scripts/telegramBot.ts)와 공유한다 (src/pipeline.ts).
    const reportInput = await collectReportInput(env, appConfig, {
      now,
      withAttachments: true,
      withJointBidStatus: true,
    });

    if (env.runMode === "hourly") return await runHourly(env, reportInput, now, state!);
    return await runWeekly(env, appConfig.recipients, reportInput, now);
  } catch (err) {
    return await handleFailure(err, env, state);
  }
}

async function runWeekly(env: Env, recipients: string[], reportInput: ReportInput, now: Date): Promise<number> {
  const report = buildReport(reportInput);
  const fetchFailed = hasFetchFailures(reportInput);

  await saveReportToDisk(report, now);

  if (env.dryRun) {
    logger.info("DRY_RUN=true → 이메일 발송을 생략합니다. output/ 폴더의 리포트 파일을 확인하세요.");
    console.log(report.text);
    return fetchFailed ? 2 : 0;
  }

  if (report.totalMatchCount === 0 && !env.sendEmptyReport) {
    logger.info("매칭 결과 0건이며 SEND_EMPTY_REPORT=false → 이메일 발송을 생략합니다.");
    return fetchFailed ? 2 : 0;
  }

  // 매시간 알림이 이미 시트에 쌓고 있지만, 그 실행이 빠졌을 때를 위해 여기서도 한 번 더 넣는다.
  // 이미 있는 공고번호는 건너뛰므로 중복되지 않는다.
  const feedbackSheetFailed = await appendToSheet(env, allMatches(reportInput), now);

  const transporter = createTransporter(env);
  await verifyTransporter(transporter);
  await sendReportEmail(report, { transporter, from: env.smtpFrom, recipients });

  return fetchFailed || feedbackSheetFailed ? 2 : 0;
}

async function runHourly(env: Env, reportInput: ReportInput, now: Date, state: NotifiedState): Promise<number> {
  const fetchFailed = hasFetchFailures(reportInput);
  const onlyNew = (source: ReportSource): ReportSource => ({
    ...source,
    matches: source.matches.filter((m) => !isNotified(state, m.notice.noticeNo)),
  });
  const fresh: ReportInput = { ...reportInput, bid: onlyNew(reportInput.bid), preStandard: onlyNew(reportInput.preStandard) };
  const freshMatches = allMatches(fresh);
  logger.info("새 공고 확인", { 매칭: allMatches(reportInput).length, 새공고: freshMatches.length });

  if (env.dryRun) {
    const messages = freshMatches.length > 0 ? buildTelegramMessages(fresh, { kind: "new" }) : [];
    console.log(`텔레그램 미리보기 (새 공고 ${freshMatches.length}건, 메시지 ${messages.length}건)`);
    messages.forEach((message, i) => console.log(`\n--- 메시지 ${i + 1}/${messages.length} ---\n${message}`));
    return fetchFailed ? 2 : 0;
  }

  if (freshMatches.length === 0) {
    // 새 공고가 없으면 아무것도 보내지 않는다. 기록은 오래된 항목 정리를 위해 저장한다.
    saveNotifiedState(env.notifiedStatePath, state, now);
    return fetchFailed ? 2 : 0;
  }

  // 시트를 알림보다 먼저 쓴다 — 알림을 보고 시트를 열었을 때 그 공고 행이 이미 있어야 한다.
  const feedbackSheetFailed = await appendToSheet(env, freshMatches, now);

  try {
    await sendTelegramReport(fresh, {
      botToken: env.telegramBotToken!,
      chatIds: env.telegramChatIds,
      kind: "new",
    });
  } catch (err) {
    // 보낸 것으로 기록하지 않는다 — 다음 실행에서 다시 보낸다.
    logger.error("텔레그램 새 공고 알림 실패 — 다음 확인 때 다시 보냅니다.", {
      error: redactSecrets(toErrorMessage(err), [env.telegramBotToken]),
    });
    saveNotifiedState(env.notifiedStatePath, state, now);
    return 2;
  }

  markNotified(state, freshMatches.map((m) => m.notice.noticeNo), now);
  saveNotifiedState(env.notifiedStatePath, state, now);
  return fetchFailed || feedbackSheetFailed ? 2 : 0;
}

function allMatches(input: ReportInput): MatchedNotice[] {
  return [...input.bid.matches, ...input.preStandard.matches];
}

/** 시트 기록이 실패해도 알림은 그대로 보낸다(알림이 본 기능이고 시트는 축적용). 실패했으면 true. */
async function appendToSheet(env: Env, matches: MatchedNotice[], now: Date): Promise<boolean> {
  if (!env.feedbackSheetEnabled || !env.googleServiceAccountJson || !env.feedbackSheetId) {
    logger.debug("피드백 시트 기록 비활성 (GOOGLE_SERVICE_ACCOUNT_JSON/FEEDBACK_SHEET_ID 미설정)");
    return false;
  }
  try {
    await appendMatchesToFeedbackSheet(matches, now, {
      serviceAccountJson: env.googleServiceAccountJson,
      spreadsheetId: env.feedbackSheetId,
      sheetName: env.feedbackSheetName,
    });
    return false;
  } catch (err) {
    logger.error("피드백 시트 기록 실패 - 알림 발송은 그대로 진행합니다.", {
      error: redactSecrets(toErrorMessage(err), [env.googleServiceAccountJson]),
    });
    return true;
  }
}

async function handleFailure(err: unknown, env: Env | undefined, state: NotifiedState | undefined): Promise<number> {
  const secrets = env
    ? [env.naraBidServiceKey, env.naraPrestdServiceKey, env.smtpPass, env.telegramBotToken, env.googleServiceAccountJson]
    : [];
  const message = redactSecrets(toErrorMessage(err), secrets);
  logger.error("실행 실패", { error: message });
  if (!env || env.dryRun) return 1;

  const now = new Date();
  // 매시간 모드에서는 장애가 이어지면 같은 알림이 매시간 쌓이므로 6시간에 한 번만 보낸다.
  const alertAllowed = env.runMode === "weekly" || (state !== undefined && shouldSendFailureAlert(state, now));

  if (alertAllowed && env.telegramEnabled && env.telegramBotToken) {
    try {
      await sendTelegramFailureAlert(message, now, { botToken: env.telegramBotToken, chatIds: env.telegramChatIds });
      if (env.runMode === "hourly" && state) {
        state.lastFailureAlertAt = now.toISOString();
        saveNotifiedState(env.notifiedStatePath, state, now);
      }
    } catch (alertErr) {
      logger.error("실패 알림 텔레그램 발송도 실패했습니다.", { error: redactSecrets(toErrorMessage(alertErr), secrets) });
    }
  }

  // 이메일 실패 알림은 주간 모드만. 매시간 모드는 SMTP를 쓰지 않는다.
  if (env.runMode === "weekly" && env.alertEmailOnFailure) {
    try {
      const appConfig = loadAppConfig();
      const transporter = createTransporter(env);
      await sendFailureAlertEmail(message, { transporter, from: env.smtpFrom, recipients: appConfig.recipients });
    } catch (alertErr) {
      logger.error("실패 알림 이메일 발송도 실패했습니다. 로그를 직접 확인해주세요.", {
        error: toErrorMessage(alertErr),
      });
    }
  }

  return 1;
}

run().then((exitCode) => {
  process.exitCode = exitCode;
});
