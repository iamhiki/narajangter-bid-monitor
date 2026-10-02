import { loadEnv, type Env } from "./config/env.js";
import { loadAppConfig } from "./config/loadJsonConfig.js";
import { collectReportInput, hasFetchFailures } from "./pipeline.js";
import { buildReport, type ReportInput, type ReportSource } from "./report/buildReport.js";
import { buildClosingSoonMessages, buildTelegramMessages } from "./notify/telegramMessage.js";
import { sendTelegramFailureAlert, sendTelegramMessages, sendTelegramReport } from "./notify/telegram.js";
import { classifyBidMethod } from "./matching/bidMethod.js";
import { CLOSING_SOON_DAYS, selectClosingSoon } from "./matching/deadline.js";
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
  recordFailure,
  shouldSendFailureAlert,
  type NotifiedState,
} from "./state/notifiedStore.js";
import { isPostedWithin } from "./state/recency.js";
import { alreadySent, loadSentReports, markSent, reportPeriodKey } from "./state/sentReports.js";
import { toErrorMessage } from "./errors.js";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

/**
 * 두 가지 모드로 돈다 (RUN_MODE).
 *
 *   weekly — 매주 한 번, 기간 전체를 이메일 리포트로, "입찰"을 뺀 공고를 텔레그램으로 보낸다.
 *   daily  — 매일 아침, 7일 안에 마감되는 "입찰" 본공고를 텔레그램으로 보고한다.
 *   hourly — 새로 나온 공고만 골라 텔레그램으로 바로 알린다. 2026-10-02부터 정기 실행하지 않는다
 *            (공고가 뜰 때마다 알림이 와서 담당자 요청으로 위 두 보고로 바꿈). 코드는 수동 실행용으로 남긴다.
 */
async function run(): Promise<number> {
  let env: Env | undefined;
  let state: NotifiedState | undefined;

  try {
    env = loadEnv();
    const appConfig = loadAppConfig();
    const now = new Date();
    if (env.runMode === "hourly") state = loadNotifiedState(env.notifiedStatePath);

    // 매일·주간 보고는 cron-job.org와 GitHub 예약 실행 두 곳이 깨운다. 먼저 보낸 쪽이 있으면 조회도 하지 않고 끝낸다.
    const scheduled = env.runMode === "hourly" ? undefined : env.runMode;
    const sent = scheduled ? loadSentReports(env.sentReportsPath) : undefined;
    if (scheduled && sent && !env.dryRun && !env.forceSend && alreadySent(sent, scheduled, now)) {
      logger.info("이번 기간 보고는 이미 보냈습니다 — 건너뜁니다 (다시 받으려면 FORCE_SEND=true)", {
        보고: scheduled,
        기간: reportPeriodKey(scheduled, now),
      });
      return 0;
    }

    // ①수집~③필터링은 텔레그램 수동 조회(scripts/telegramBot.ts)와 공유한다 (src/pipeline.ts).
    const reportInput = await collectReportInput(env, appConfig, {
      now,
      // 매일 보고는 30일치를 훑어 마감 임박 건만 추리므로 첨부까지 받으면 느려지기만 한다.
      withAttachments: env.runMode !== "daily",
      withJointBidStatus: true,
    });

    if (env.runMode === "hourly") return await runHourly(env, reportInput, now, state!);
    const exitCode =
      env.runMode === "daily"
        ? await runDaily(env, reportInput, now)
        : await runWeekly(env, appConfig.recipients, reportInput, now);
    // 여기까지 왔으면 보고는 나갔다 (발송 실패는 위에서 예외로 빠진다). 일부 조회 실패(2)여도 보낸 것으로 친다.
    if (scheduled && sent && !env.dryRun) markSent(env.sentReportsPath, sent, scheduled, now);
    return exitCode;
  } catch (err) {
    return await handleFailure(err, env, state);
  }
}

async function runWeekly(env: Env, recipients: string[], reportInput: ReportInput, now: Date): Promise<number> {
  const report = buildReport(reportInput);
  const fetchFailed = hasFetchFailures(reportInput);

  await saveReportToDisk(report, now);

  const weeklyInput = withoutBids(reportInput);
  if (env.dryRun) {
    logger.info("DRY_RUN=true → 이메일·텔레그램 발송을 생략합니다. output/ 폴더의 리포트 파일을 확인하세요.");
    console.log(report.text);
    const messages = buildTelegramMessages(weeklyInput, { kind: "weekly" });
    console.log(`\n텔레그램 미리보기 (주간 공고 ${allMatches(weeklyInput).length}건, 메시지 ${messages.length}건)`);
    messages.forEach((message, i) => console.log(`\n--- 메시지 ${i + 1}/${messages.length} ---\n${message}`));
    return fetchFailed ? 2 : 0;
  }

  const telegramFailed = await sendWeeklyTelegram(env, weeklyInput);

  if (report.totalMatchCount === 0 && !env.sendEmptyReport) {
    logger.info("매칭 결과 0건이며 SEND_EMPTY_REPORT=false → 이메일 발송을 생략합니다.");
    return fetchFailed || telegramFailed ? 2 : 0;
  }

  // 피드백 시트에 쌓는다 (매시간 알림을 끈 뒤로는 여기가 시트에 넣는 곳이다).
  // 이미 있는 공고번호는 건너뛰므로 중복되지 않는다.
  const feedbackSheetFailed = await appendToSheet(env, allMatches(reportInput), now);

  const transporter = createTransporter(env);
  await verifyTransporter(transporter);
  await sendReportEmail(report, { transporter, from: env.smtpFrom, recipients });

  return fetchFailed || feedbackSheetFailed || telegramFailed ? 2 : 0;
}

/**
 * 주간 텔레그램 보고에서 "입찰"(적격심사·최저가 등) 본공고를 뺀다 — 입찰은 매일 마감 임박 보고가 맡는다.
 * 협상·규격가격동시 본공고와 사전규격이 남는다. 낙찰방법을 모르는 공고는 남긴다 (모르면 보내는 쪽).
 * 이메일 주간 리포트는 지금처럼 전체를 담는다.
 */
function withoutBids(input: ReportInput): ReportInput {
  return {
    ...input,
    bid: { ...input.bid, matches: input.bid.matches.filter((m) => classifyBidMethod(m.notice.bidMethod) !== "입찰") },
  };
}

/** 텔레그램이 실패해도 이메일은 그대로 보낸다. 실패했으면 true. 0건이어도 보낸다 — 안 오면 고장인지 모른다. */
async function sendWeeklyTelegram(env: Env, input: ReportInput): Promise<boolean> {
  if (!env.telegramEnabled || !env.telegramBotToken) {
    logger.info("텔레그램 설정이 없어 주간 텔레그램 보고를 건너뜁니다.");
    return false;
  }
  try {
    await sendTelegramReport(input, { botToken: env.telegramBotToken, chatIds: env.telegramChatIds, kind: "weekly" });
    return false;
  } catch (err) {
    logger.error("주간 텔레그램 보고 실패 - 이메일 발송은 그대로 진행합니다.", {
      error: redactSecrets(toErrorMessage(err), [env.telegramBotToken]),
    });
    return true;
  }
}

async function runHourly(env: Env, reportInput: ReportInput, now: Date, state: NotifiedState): Promise<number> {
  // 수집까지 왔으면 연결은 살아 있다 — 연속 실패 횟수를 되돌린다 (기록은 아래 저장 때 함께 남는다)
  state.consecutiveFailures = 0;
  const fetchFailed = hasFetchFailures(reportInput);
  const onlyNew = (source: ReportSource): ReportSource => ({
    ...source,
    // 아직 안 보냈고 최근 24시간 안에 올라온 공고만. 조회는 7일치라 기간 전체 개수도 함께 센다
    matches: source.matches.filter((m) => !isNotified(state, m.notice.noticeNo) && isPostedWithin(m.notice.postedAt, now)),
  });
  const fresh: ReportInput = { ...reportInput, bid: onlyNew(reportInput.bid), preStandard: onlyNew(reportInput.preStandard) };
  const freshMatches = allMatches(fresh);
  const windowTotal = { days: env.lookbackDays, count: allMatches(reportInput).length };
  logger.info("새 공고 확인", { 매칭: allMatches(reportInput).length, 새공고: freshMatches.length });

  if (env.dryRun) {
    const messages = freshMatches.length > 0 ? buildTelegramMessages(fresh, { kind: "new", windowTotal }) : [];
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
      windowTotal,
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

/**
 * 매일 마감 임박 보고 — 7일 안에 마감되는 "입찰"(적격심사·최저가 등) 본공고.
 *
 * 2026-09-29 미팅: 입찰은 공고 후 7일 안에 마감되는 경우가 있어 주간 리포트로는 늦는다.
 * 협상·규격가격동시는 제안서 준비 기간이 길어 여기 넣지 않는다 (주간 보고로 받는다).
 * 이미 알린 공고도 마감 전까지 매일 다시 보내므로 알림 기록(notified.json)을 쓰지 않는다.
 */
async function runDaily(env: Env, reportInput: ReportInput, now: Date): Promise<number> {
  const fetchFailed = hasFetchFailures(reportInput);
  const bids = reportInput.bid.matches.filter((m) => classifyBidMethod(m.notice.bidMethod) === "입찰");
  const closingSoon = selectClosingSoon(bids, now, CLOSING_SOON_DAYS);
  logger.info("마감 임박 입찰", { 본공고매칭: reportInput.bid.matches.length, 입찰: bids.length, 마감임박: closingSoon.length });

  const messages = buildClosingSoonMessages(reportInput, closingSoon, { days: CLOSING_SOON_DAYS });
  if (env.dryRun) {
    console.log(`텔레그램 미리보기 (마감 임박 입찰 ${closingSoon.length}건, 메시지 ${messages.length}건)`);
    messages.forEach((message, i) => console.log(`\n--- 메시지 ${i + 1}/${messages.length} ---\n${message}`));
    return fetchFailed ? 2 : 0;
  }

  await sendTelegramMessages(messages, { botToken: env.telegramBotToken!, chatIds: env.telegramChatIds });
  return fetchFailed ? 2 : 0;
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
  if (env.runMode === "hourly" && state) {
    recordFailure(state);
    // 알림을 안 보내도 횟수는 남겨야 다음 실행이 "연속"인지 안다
    saveNotifiedState(env.notifiedStatePath, state, now);
  }
  // 매시간 모드에서는 장애가 이어지면 같은 알림이 매시간 쌓이므로 6시간에 한 번만 보낸다.
  // 주간·매일 모드는 하루 한 번 이하로 돌기 때문에 매번 알려도 쌓이지 않는다.
  const alertAllowed = env.runMode !== "hourly" || (state !== undefined && shouldSendFailureAlert(state, now));

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
