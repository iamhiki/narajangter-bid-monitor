import { loadEnv, type Env } from "./config/env.js";
import { loadAppConfig } from "./config/loadJsonConfig.js";
import { collectReportInput, hasFetchFailures } from "./pipeline.js";
import { buildReport } from "./report/buildReport.js";
import { buildTelegramMessages } from "./notify/telegramMessage.js";
import { sendTelegramFailureAlert, sendTelegramReport } from "./notify/telegram.js";
import { appendMatchesToFeedbackSheet } from "./sheets/feedbackSheet.js";
import { saveReportToDisk } from "./report/saveReport.js";
import { createTransporter, verifyTransporter } from "./email/mailer.js";
import { sendFailureAlertEmail, sendReportEmail } from "./email/sendReportEmail.js";
import { toErrorMessage } from "./errors.js";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

async function run(): Promise<number> {
  let env: Env | undefined;

  try {
    env = loadEnv();
    const appConfig = loadAppConfig();

    const now = new Date();
    // ①수집~③필터링은 텔레그램 수동 조회(scripts/telegramBot.ts)와 공유한다 (src/pipeline.ts).
    const reportInput = await collectReportInput(env, appConfig, {
      now,
      withAttachments: true,
      withJointBidStatus: true,
    });
    const report = buildReport(reportInput);
    const fetchFailed = hasFetchFailures(reportInput);

    await saveReportToDisk(report, now);

    if (env.dryRun) {
      logger.info("DRY_RUN=true → 이메일/텔레그램 발송을 생략합니다. output/ 폴더의 리포트 파일을 확인하세요.");
      console.log(report.text);

      // 텔레그램은 4096자 제한 때문에 메시지가 여러 건으로 쪼개진다. 실제로 몇 건이
      // 어떤 모양으로 나가는지 발송 전에 눈으로 확인할 수 있게 그대로 출력한다.
      const telegramMessages = buildTelegramMessages(reportInput);
      const rule = "=".repeat(60);
      console.log(rule);
      console.log(`텔레그램 미리보기 (총 ${telegramMessages.length}건)`);
      console.log(rule);
      telegramMessages.forEach((message, i) => {
        console.log(
          `\n--- 메시지 ${i + 1}/${telegramMessages.length} (${message.length}자) ---\n${message}`
        );
      });

      return fetchFailed ? 2 : 0;
    }

    if (report.totalMatchCount === 0 && !env.sendEmptyReport) {
      logger.info("매칭 결과 0건이며 SEND_EMPTY_REPORT=false → 이메일 발송을 생략합니다.");
      return fetchFailed ? 2 : 0;
    }

    // 피드백 시트를 알림보다 먼저 쓴다 - 담당자가 알림을 보고 시트를 열었을 때
    // 해당 공고 행이 이미 있어야 바로 판정할 수 있기 때문이다.
    // 시트 기록이 실패해도 알림 발송은 그대로 진행한다(알림이 본 기능이고 시트는 축적용).
    let feedbackSheetFailed = false;
    if (env.feedbackSheetEnabled && env.googleServiceAccountJson && env.feedbackSheetId) {
      try {
        const allMatches = [...reportInput.bid.matches, ...reportInput.preStandard.matches];
        await appendMatchesToFeedbackSheet(allMatches, now, {
          serviceAccountJson: env.googleServiceAccountJson,
          spreadsheetId: env.feedbackSheetId,
          sheetName: env.feedbackSheetName,
        });
      } catch (err) {
        feedbackSheetFailed = true;
        logger.error("피드백 시트 기록 실패 - 알림 발송은 그대로 진행합니다.", {
          error: redactSecrets(toErrorMessage(err), [env.googleServiceAccountJson]),
        });
      }
    } else {
      logger.debug("피드백 시트 기록 비활성 (GOOGLE_SERVICE_ACCOUNT_JSON/FEEDBACK_SHEET_ID 미설정)");
    }

    // 텔레그램을 이메일보다 먼저 보낸다. SMTP가 죽어 있어도 알림은 받을 수 있고,
    // 반대로 아직 실험 단계인 텔레그램이 실패해도 이미 돌아가던 이메일 경로를 막지 않는다.
    let telegramFailed = false;
    if (env.telegramEnabled && env.telegramBotToken) {
      try {
        await sendTelegramReport(reportInput, {
          botToken: env.telegramBotToken,
          chatIds: env.telegramChatIds,
          // 요약 메시지 뒤에 전체 내용을 HTML 파일로 붙인다(텍스트는 4096자 제한).
          attachHtml: report.totalMatchCount > 0 ? report.html : undefined,
        });
      } catch (err) {
        telegramFailed = true;
        logger.error("텔레그램 발송 실패 — 이메일 발송은 그대로 진행합니다.", {
          error: redactSecrets(toErrorMessage(err), [env.telegramBotToken]),
        });
      }
    } else {
      logger.debug("텔레그램 발송 비활성 (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_IDS 미설정 또는 TELEGRAM_ENABLED=false)");
    }

    const transporter = createTransporter(env);
    await verifyTransporter(transporter);
    await sendReportEmail(report, {
      transporter,
      from: env.smtpFrom,
      recipients: appConfig.recipients,
    });

    return fetchFailed || telegramFailed || feedbackSheetFailed ? 2 : 0;
  } catch (err) {
    const secrets = env
      ? [
          env.naraBidServiceKey,
          env.naraPrestdServiceKey,
          env.smtpPass,
          env.telegramBotToken,
          env.googleServiceAccountJson,
        ]
      : [];
    const message = redactSecrets(toErrorMessage(err), secrets);
    logger.error("실행 실패", { error: message });

    if (env && !env.dryRun && env.telegramEnabled && env.telegramBotToken) {
      try {
        await sendTelegramFailureAlert(message, new Date(), {
          botToken: env.telegramBotToken,
          chatIds: env.telegramChatIds,
        });
      } catch (alertErr) {
        logger.error("실패 알림 텔레그램 발송도 실패했습니다.", {
          error: redactSecrets(toErrorMessage(alertErr), secrets),
        });
      }
    }

    if (env && !env.dryRun && env.alertEmailOnFailure) {
      try {
        const appConfig = loadAppConfig();
        const transporter = createTransporter(env);
        await sendFailureAlertEmail(message, {
          transporter,
          from: env.smtpFrom,
          recipients: appConfig.recipients,
        });
      } catch (alertErr) {
        logger.error("실패 알림 이메일 발송도 실패했습니다. 로그를 직접 확인해주세요.", {
          error: toErrorMessage(alertErr),
        });
      }
    }

    return 1;
  }
}

run().then((exitCode) => {
  process.exitCode = exitCode;
});
