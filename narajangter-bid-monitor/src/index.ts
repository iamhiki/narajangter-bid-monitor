import { loadEnv, type Env } from "./config/env.js";
import { loadAppConfig } from "./config/loadJsonConfig.js";
import { collectReportInput, hasFetchFailures } from "./pipeline.js";
import { buildReport, type ReportInput, type ReportSource } from "./report/buildReport.js";
import { buildTelegramMessages } from "./notify/telegramMessage.js";
import { sendTelegramReport } from "./notify/telegram.js";
import { hasDevAlertTarget, sendDevAlert, type DevAlertTargets } from "./notify/devAlert.js";
import { classifyBidMethod } from "./matching/bidMethod.js";
import { appendMatchesToFeedbackSheet } from "./sheets/feedbackSheet.js";
import { saveReportToDisk } from "./report/saveReport.js";
import { createTransporter, verifyTransporter } from "./email/mailer.js";
import { sendReportEmail } from "./email/sendReportEmail.js";
import type { MatchedNotice } from "./matching/types.js";
import {
  isNotified,
  loadNotifiedState,
  markNotified,
  saveNotifiedState,
  type NotifiedState,
} from "./state/notifiedStore.js";
import { isPostedWithin, NEW_BID_HOURS } from "./state/recency.js";
import { alreadySent, loadSentReports, markSent, reportPeriodKey } from "./state/sentReports.js";
import { toErrorMessage } from "./errors.js";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

/**
 * 두 가지 모드로 돈다 (RUN_MODE).
 *
 *   weekly — 매주 한 번, 기간 전체를 이메일 리포트로, "입찰"을 뺀 공고를 텔레그램으로 보낸다.
 *   daily  — 매일 아침, 새로 올라온 "입찰"(적격심사·최저가 등) 본공고만 텔레그램으로 알린다.
 *   hourly — 새로 나온 공고만 골라 텔레그램으로 바로 알린다. 2026-10-02부터 정기 실행하지 않는다
 *            (공고가 뜰 때마다 알림이 와서 담당자 요청으로 끔). 코드는 수동 실행용으로 남긴다.
 */
async function run(): Promise<number> {
  let env: Env | undefined;
  let state: NotifiedState | undefined;

  try {
    env = loadEnv();
    const appConfig = loadAppConfig();
    const now = new Date();
    if (env.runMode === "hourly" || env.runMode === "daily") state = loadNotifiedState(env.notifiedStatePath);

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
      // 매일 알림은 새 입찰 공고 몇 건만 보내므로 첨부까지 받으면 느려지기만 한다 (자세한 건 담당자 화면).
      withAttachments: env.runMode !== "daily",
      withJointBidStatus: true,
    });

    if (env.runMode === "hourly") return await runHourly(env, reportInput, now, state!);
    const exitCode =
      env.runMode === "daily"
        ? await runDaily(env, reportInput, now, state!)
        : await runWeekly(env, appConfig.recipients, reportInput, now);
    // 여기까지 왔으면 보고는 나갔다 (발송 실패는 위에서 예외로 빠진다). 일부 조회 실패(2)여도 보낸 것으로 친다.
    if (scheduled && sent && !env.dryRun) markSent(env.sentReportsPath, sent, scheduled, now);
    return exitCode;
  } catch (err) {
    return await handleFailure(err, env);
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
 * 주간 텔레그램 보고에서 "입찰"(적격심사·최저가 등) 본공고를 뺀다 — 입찰은 매일 아침 새 공고 알림이 맡는다.
 * 협상·규격가격동시 본공고와 사전규격이 남는다. 낙찰방법을 모르는 공고는 남긴다 (모르면 보내는 쪽).
 * 이메일 주간 리포트는 전체를 담는다.
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
 * 매일 아침 새 "입찰"(적격심사·최저가 등) 본공고 알림.
 *
 * 2026-09-29 미팅: 입찰은 공고 후 7일 안에 마감되는 경우가 있어 주간 보고로는 늦다.
 * 2026-10-12 담당자 요청: 마감 전까지 같은 공고를 매일 다시 보내지 말고 새로 올라온 공고만 보낸다
 * (마감 임박 공고는 담당자 화면에서 본다). 이미 알린 공고는 알림 기록(notified.json)으로 거르고,
 * 새 공고가 없는 날은 아무것도 보내지 않는다.
 * 협상·규격가격동시는 제안서 준비 기간이 길어 여기 넣지 않는다 (주간 보고로 받는다).
 */
async function runDaily(env: Env, reportInput: ReportInput, now: Date, state: NotifiedState): Promise<number> {
  state.consecutiveFailures = 0;
  const fetchFailed = hasFetchFailures(reportInput);
  const bids = reportInput.bid.matches.filter((m) => classifyBidMethod(m.notice.bidMethod) === "입찰");
  const fresh = bids.filter(
    (m) => !isNotified(state, m.notice.noticeNo) && isPostedWithin(m.notice.postedAt, now, NEW_BID_HOURS)
  );
  logger.info("새 입찰 공고", { 본공고매칭: reportInput.bid.matches.length, 입찰: bids.length, 새공고: fresh.length });

  const input: ReportInput = {
    ...reportInput,
    bid: { ...reportInput.bid, matches: fresh },
    preStandard: { ...reportInput.preStandard, matches: [] },
  };
  if (env.dryRun) {
    const messages = fresh.length > 0 ? buildTelegramMessages(input, { kind: "newBids" }) : [];
    console.log(`텔레그램 미리보기 (새 입찰 공고 ${fresh.length}건, 메시지 ${messages.length}건)`);
    messages.forEach((message, i) => console.log(`\n--- 메시지 ${i + 1}/${messages.length} ---\n${message}`));
    return fetchFailed ? 2 : 0;
  }

  if (fresh.length > 0) {
    // 보내다 실패하면 예외로 빠져 기록이 남지 않는다 — 다음 실행(예비 실행 포함)이 다시 보낸다.
    await sendTelegramReport(input, { botToken: env.telegramBotToken!, chatIds: env.telegramChatIds, kind: "newBids" });
    markNotified(state, fresh.map((m) => m.notice.noticeNo), now);
  }
  saveNotifiedState(env.notifiedStatePath, state, now);
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

/**
 * 실행 실패 — 담당자 텔레그램 방·수신자 이메일로는 알리지 않고, 개발자 대화방(텔레그램)·웹훅으로만 원문을 보낸다.
 *
 * 2026-10-12 담당자 요청: 실패는 4~5번에 한 번꼴(대부분 GitHub→나라장터 접속 끊김)이고 보고가 빠져도
 * 사내 화면에서 공고를 볼 수 있어, 담당자가 실패 알림을 받을 이유가 없다. 개발자는 따로 받는다 (src/notify/devAlert.ts).
 */
async function handleFailure(err: unknown, env: Env | undefined): Promise<number> {
  const secrets = env
    ? [env.naraBidServiceKey, env.naraPrestdServiceKey, env.smtpPass, env.telegramBotToken, env.googleServiceAccountJson]
    : [];
  const message = redactSecrets(toErrorMessage(err), secrets);
  logger.error("실행 실패", { error: message });
  if (!env || env.dryRun) return 1;

  const targets: DevAlertTargets = {
    webhookUrl: env.devAlertWebhookUrl,
    telegram:
      env.devAlertTelegramChatId && env.telegramBotToken
        ? { botToken: env.telegramBotToken, chatId: env.devAlertTelegramChatId }
        : undefined,
  };
  if (!hasDevAlertTarget(targets)) {
    logger.info("DEV_ALERT_TELEGRAM_CHAT_ID·DEV_ALERT_WEBHOOK_URL이 없어 개발자 실패 알림을 건너뜁니다.");
    return 1;
  }
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  await sendDevAlert(targets, {
    runMode: env.runMode,
    errorMessage: message,
    occurredAt: new Date(),
    backupRun: env.backupRun,
    runUrl:
      GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
        ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : undefined,
  });
  return 1;
}

run().then((exitCode) => {
  process.exitCode = exitCode;
});
