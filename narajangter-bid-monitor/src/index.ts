import { loadEnv, type Env } from "./config/env.js";
import { loadAppConfig } from "./config/loadJsonConfig.js";
import { collectReportInput, hasFetchFailures, type CollectedInput } from "./pipeline.js";
import { buildReport, type ReportInput, type ReportSource } from "./report/buildReport.js";
import {
  buildPeriodReportFilename,
  buildPeriodReportMessages,
  buildTelegramMessages,
  type PeriodReportOptions,
} from "./notify/telegramMessage.js";
import { sendPeriodReport, sendTelegramReport } from "./notify/telegram.js";
import { describeFailure, hasDevAlertTarget, sendDevAlert, sendDevResolved, type DevAlertTargets } from "./notify/devAlert.js";
import { closeIssueOpenedBefore, loadDevAlertState, openIssue, saveDevAlertState } from "./state/devAlertState.js";
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
import {
  dailyPeriod,
  isKstWeekend,
  isPostedIn,
  isPostedWithin,
  periodWindow,
  previousDays,
  type PostedPeriod,
} from "./state/recency.js";
import { alreadySent, loadSentReports, markSent, reportPeriodKey } from "./state/sentReports.js";
import { buildReportLog, writeReportLog, type ReportKind } from "./state/reportLog.js";
import { toErrorMessage } from "./errors.js";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

/**
 * 두 가지 모드로 돈다 (RUN_MODE).
 *
 *   weekly — 매주 월 09:10, 지난 7일 게시분을 이메일 리포트로, "입찰"을 뺀 공고(협상·규격가격·사전규격)를 텔레그램으로 보낸다.
 *   daily  — 평일 09:00, 전날 게시된 "입찰"(적격심사·최저가 등) 본공고를 텔레그램으로 보내고 구글 시트에도 쌓는다
 *            (월요일은 금~일 게시분).
 *   hourly — 새로 나온 공고만 골라 텔레그램으로 바로 알린다. 2026-10-02부터 정기 실행하지 않는다
 *            (공고가 뜰 때마다 알림이 와서 담당자 요청으로 끔). 코드는 수동 실행용으로 남긴다.
 */
/** 이번 실행이 시작된 시각 — 이번 실행 중에 생긴 문제와 그 전에 생긴 문제를 가른다 (해결 알림) */
const runStartedAt = new Date();

async function run(): Promise<number> {
  let env: Env | undefined;
  let state: NotifiedState | undefined;

  try {
    env = loadEnv();
    const appConfig = loadAppConfig();
    const now = new Date();
    if (env.runMode === "hourly") state = loadNotifiedState(env.notifiedStatePath);

    // 매일 입찰 보고는 평일만 보낸다 (2026-10-19 담당자 요청). 주말 게시분은 월요일 보고에 담긴다 (dailyPeriod).
    // cron-job.org가 주말에도 깨우므로 여기서 거른다. 주말에 꼭 받아야 하면 FORCE_SEND=true로 수동 실행한다.
    if (env.runMode === "daily" && !env.forceSend && isKstWeekend(now)) {
      logger.info("주말에는 매일 입찰 보고를 보내지 않습니다 — 월요일 보고에 함께 담깁니다.");
      return 0;
    }

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
      // 정기 보고 머리말의 "마감 지난 N건 제외"를 세려고 마감 지난 본공고도 같은 조건으로 받는다
      withClosed: env.runMode !== "hourly",
    });

    if (env.runMode === "hourly") return await runHourly(env, reportInput, now, state!);
    const exitCode =
      env.runMode === "daily"
        ? await runDaily(env, reportInput, now)
        : await runWeekly(env, appConfig.recipients, reportInput, now);
    // 여기까지 왔으면 보고는 나갔다 (발송 실패는 위에서 예외로 빠진다). 일부 조회 실패(2)여도 보낸 것으로 친다.
    if (scheduled && sent && !env.dryRun) markSent(env.sentReportsPath, sent, scheduled, now);
    if (!env.dryRun) await alertResolved(env);
    return exitCode;
  } catch (err) {
    return await handleFailure(err, env);
  }
}

async function runWeekly(env: Env, recipients: string[], collected: CollectedInput, now: Date): Promise<number> {
  // 지난 7일(지난주 월~일) 게시분. 이메일 리포트도 같은 기간으로 맞춘다.
  const period = previousDays(now, 7);
  const reportInput = postedIn(collected, period);
  const report = buildReport(reportInput);
  const fetchFailed = hasFetchFailures(reportInput);

  await saveReportToDisk(report, now);

  const weeklyInput = withoutBids(reportInput);
  const options: PeriodReportOptions = {
    kind: "weekly",
    period,
    closedCount: closedIn(collected, period, (m) => classifyBidMethod(m.notice.bidMethod) !== "입찰"),
  };
  if (env.dryRun) {
    logger.info("DRY_RUN=true → 이메일·텔레그램 발송을 생략합니다. output/ 폴더의 리포트 파일을 확인하세요.");
    console.log(report.text);
    printPreview(buildPeriodReportMessages(weeklyInput, options));
    return fetchFailed ? 2 : 0;
  }

  const telegramFailed = await sendWeeklyTelegram(env, weeklyInput, options);
  // 텔레그램으로 나간 공고(입찰 제외)를 사내 화면 판단 기록에 쌓도록 남긴다. 텔레그램이 일부 실패해도 이메일로는 나간다
  if (env.telegramEnabled && env.telegramBotToken) saveReportLog("weekly", allMatches(weeklyInput), now);

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

/** 게시일이 기간 안인 공고만 남긴다. 첨부 리포트의 조회 기간 표시도 그 기간으로 바꾼다. */
function postedIn(input: ReportInput, period: PostedPeriod): ReportInput {
  const keep = (source: ReportSource): ReportSource => ({
    ...source,
    matches: source.matches.filter((m) => isPostedIn(m.notice.postedAt, period)),
  });
  return { ...input, window: periodWindow(period), bid: keep(input.bid), preStandard: keep(input.preStandard) };
}

/** 같은 기간·같은 종류인데 마감이 이미 지나 목록에서 빠진 본공고 수 (머리말 "마감 지난 N건 제외") */
function closedIn(collected: CollectedInput, period: PostedPeriod, wanted: (m: MatchedNotice) => boolean): number {
  return (collected.closed ?? []).filter((m) => isPostedIn(m.notice.postedAt, period) && wanted(m)).length;
}

function printPreview(messages: string[]): void {
  console.log(`\n텔레그램 미리보기 (메시지 ${messages.length}건)`);
  messages.forEach((message, i) => console.log(`\n--- 메시지 ${i + 1}/${messages.length} ---\n${message}`));
}

/** 정기 보고 첨부 리포트 — 목록에 공고가 있을 때만 */
function periodAttachment(input: ReportInput, options: PeriodReportOptions) {
  const count = allMatches(input).length;
  if (count === 0) return null;
  const title = options.kind === "daily" ? "입찰 공고 상세 리포트" : "협상·규격가격·사전규격 공고 상세 리포트";
  return {
    filename: buildPeriodReportFilename(options),
    content: buildReport(input, { title }).html,
    caption: `📄 상세 리포트 (${count}건)`,
  };
}

/**
 * 주간 텔레그램 보고에서 "입찰"(적격심사·최저가 등) 본공고를 뺀다 — 입찰은 매일 09:00 보고가 맡는다.
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
async function sendWeeklyTelegram(env: Env, input: ReportInput, options: PeriodReportOptions): Promise<boolean> {
  if (!env.telegramEnabled || !env.telegramBotToken) {
    logger.info("텔레그램 설정이 없어 주간 텔레그램 보고를 건너뜁니다.");
    return false;
  }
  try {
    const failures = await sendPeriodReport(buildPeriodReportMessages(input, options), periodAttachment(input, options), {
      botToken: env.telegramBotToken,
      chatIds: env.telegramChatIds,
    });
    await alertPartialFailure(env, failures);
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
 * 평일 09:00 입찰 보고 — 전날(한국 날짜) 게시된 "입찰"(적격심사·최저가 등) 본공고.
 * 주말에는 보내지 않고, 월요일 보고가 금~일 게시분을 받는다 (2026-10-19 담당자 요청).
 *
 * 2026-09-29 미팅: 입찰은 공고 후 7일 안에 마감되는 경우가 있어 주간 보고로는 늦다.
 * 2026-10-15 담당자 정리: 전날 게시분만 보내고, 없으면 "새 공고 없음"을 보낸다. 날짜로 끊으므로
 * 이미 알린 공고 기록 없이도 같은 공고가 두 번 가지 않는다 (같은 날 두 번 도는 건 발송 기록이 막는다).
 * 협상·규격가격동시는 제안서 준비 기간이 길어 여기 넣지 않는다 (주간 보고로 받는다).
 */
async function runDaily(env: Env, collected: CollectedInput, now: Date): Promise<number> {
  const fetchFailed = hasFetchFailures(collected);
  const period = dailyPeriod(now);
  const isBid = (m: MatchedNotice) => classifyBidMethod(m.notice.bidMethod) === "입찰";
  const posted = postedIn(collected, period);
  const input: ReportInput = {
    ...posted,
    bid: { ...posted.bid, matches: posted.bid.matches.filter(isBid) },
    preStandard: { ...posted.preStandard, matches: [] },
  };
  const options: PeriodReportOptions = { kind: "daily", period, closedCount: closedIn(collected, period, isBid) };
  logger.info("전날 게시 입찰 공고", { 게시일: `${period.from}~${period.to}`, 입찰: input.bid.matches.length, 마감지남: options.closedCount });

  const messages = buildPeriodReportMessages(input, options);
  if (env.dryRun) {
    printPreview(messages);
    return fetchFailed ? 2 : 0;
  }
  if (!env.telegramEnabled || !env.telegramBotToken) {
    logger.info("텔레그램 설정이 없어 매일 입찰 보고를 건너뜁니다.");
    return fetchFailed ? 2 : 0;
  }
  // 보내다 실패하면 예외로 빠져 발송 기록이 남지 않는다 — 예비 실행이 다시 보낸다.
  const failures = await sendPeriodReport(messages, periodAttachment(input, options), {
    botToken: env.telegramBotToken,
    chatIds: env.telegramChatIds,
  });
  saveReportLog("daily", allMatches(input), now);
  // 구글 시트에도 쌓는다 (2026-10-19) — 사무실 PC가 꺼져 있어도 시트에서 보고된 공고를 볼 수 있게.
  // 주간 보고와 같은 시트이고, 이미 있는 공고번호는 건너뛰어 두 보고에 같은 공고가 나와도 한 줄이다
  const feedbackSheetFailed = await appendToSheet(env, allMatches(input), now);
  await alertPartialFailure(env, failures);
  return fetchFailed || feedbackSheetFailed ? 2 : 0;
}

/** 워크플로가 올릴 보고 기록 폴더 (output/은 저장소에 올리지 않는다) */
const REPORT_LOG_DIR = "output/report-log";

/**
 * 보고에 나간 공고 목록을 남긴다 — 워크플로가 report-log 브랜치에 올리고, 사내 화면이 받아 판단 기록에 '미판단'으로 쌓는다
 * (src/state/reportLog.ts). 0건이어도 남기지 않는다 — 쌓을 게 없다. 실패해도 보고는 이미 나갔으니 경고만 남긴다.
 */
function saveReportLog(kind: ReportKind, matches: MatchedNotice[], now: Date): void {
  if (matches.length === 0) return;
  try {
    const path = writeReportLog(REPORT_LOG_DIR, buildReportLog(kind, matches, now));
    logger.info("보고 기록을 남겼습니다 (사내 화면 판단 기록용)", { path, 공고: matches.length });
  } catch (err) {
    logger.warn("보고 기록을 남기지 못했습니다 — 사내 화면 판단 기록에 이번 보고가 쌓이지 않습니다", { error: toErrorMessage(err) });
  }
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
function devAlertTargets(env: Env): DevAlertTargets {
  return {
    webhookUrl: env.devAlertWebhookUrl,
    telegram:
      env.devAlertTelegramChatId && env.telegramBotToken
        ? { botToken: env.telegramBotToken, chatId: env.devAlertTelegramChatId }
        : undefined,
  };
}

function githubRunUrl(): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : undefined;
}

/**
 * 보고는 나갔는데 일부 대화방(예: 담당자 그룹방)에만 못 갔을 때 개발자에게 알린다.
 * 모두 실패하면 예외로 빠져 handleFailure가 알리지만, 일부 실패는 실행이 성공으로 끝나 묻힌다.
 */
async function alertPartialFailure(env: Env, failures: string[]): Promise<void> {
  if (failures.length === 0) return;
  recordOpenIssue(env, "일부 대화방 발송 실패");
  const targets = devAlertTargets(env);
  if (!hasDevAlertTarget(targets)) {
    logger.info("DEV_ALERT_TELEGRAM_CHAT_ID·DEV_ALERT_WEBHOOK_URL이 없어 일부 발송 실패 알림을 건너뜁니다.");
    return;
  }
  await sendDevAlert(targets, {
    runMode: env.runMode,
    errorMessage: failures.join("\n"),
    occurredAt: new Date(),
    backupRun: env.backupRun,
    runUrl: githubRunUrl(),
    partial: true,
  });
}

/** 개발자에게 알린 문제를 기록해 둔다 — 다음 실행이 정상이면 해결 알림을 보낸다 */
function recordOpenIssue(env: Env, summary: string): void {
  const state = loadDevAlertState(env.devAlertStatePath);
  openIssue(state, env.runMode, summary, new Date());
  saveDevAlertState(env.devAlertStatePath, state);
}

/**
 * 앞서 실패를 알린 보고가 이번 실행에서 정상으로 나갔으면 "해결됨"을 알린다 (2026-10-16 요청).
 * 이번 실행에서 또 일부 대화방 발송 실패가 났으면 아직 안 풀린 것이라 알리지 않는다.
 */
async function alertResolved(env: Env): Promise<void> {
  const state = loadDevAlertState(env.devAlertStatePath);
  const issue = closeIssueOpenedBefore(state, env.runMode, runStartedAt);
  if (!issue) return;
  saveDevAlertState(env.devAlertStatePath, state);
  const targets = devAlertTargets(env);
  if (!hasDevAlertTarget(targets)) return;
  await sendDevResolved(targets, {
    runMode: env.runMode,
    issue,
    resolvedAt: new Date(),
    backupRun: env.backupRun,
    runUrl: githubRunUrl(),
  });
}

async function handleFailure(err: unknown, env: Env | undefined): Promise<number> {
  const secrets = env
    ? [env.naraBidServiceKey, env.naraPrestdServiceKey, env.smtpPass, env.telegramBotToken, env.googleServiceAccountJson]
    : [];
  const message = redactSecrets(toErrorMessage(err), secrets);
  logger.error("실행 실패", { error: message });
  if (!env || env.dryRun) return 1;
  recordOpenIssue(env, describeFailure(message));

  const targets = devAlertTargets(env);
  if (!hasDevAlertTarget(targets)) {
    logger.info("DEV_ALERT_TELEGRAM_CHAT_ID·DEV_ALERT_WEBHOOK_URL이 없어 개발자 실패 알림을 건너뜁니다.");
    return 1;
  }
  await sendDevAlert(targets, {
    runMode: env.runMode,
    errorMessage: message,
    occurredAt: new Date(),
    backupRun: env.backupRun,
    runUrl: githubRunUrl(),
  });
  return 1;
}

run().then((exitCode) => {
  process.exitCode = exitCode;
});
