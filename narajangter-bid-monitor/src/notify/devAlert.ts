import { toErrorMessage } from "../errors.js";
import { logger } from "../logger.js";

/**
 * 개발자용 실행 실패 알림 (웹훅).
 *
 * 2026-10-12 담당자 요청: 실패 알림은 담당자 텔레그램 방·수신자 이메일로 보내지 않는다. 보고가 빠져도
 * 담당자는 사내 화면에서 공고를 볼 수 있고, 실패는 4~5번에 한 번꼴이라 알림 피로만 쌓인다.
 * 대신 개발자가 오류를 볼 수 있게 웹훅(DEV_ALERT_WEBHOOK_URL)으로 원문과 실행 기록 링크를 보낸다.
 * 아침 실행 실패도 보낸다 — 예비 실행까지 GitHub이 건너뛰면 보고가 조용히 빠지는데, 그걸 알 수 있는 곳은 여기뿐이다.
 *
 * Discord·Slack 웹훅을 받는다. 그 밖의 주소에는 {text, content}를 함께 보낸다.
 */

/** 실패 원인 한 줄 — 원문 위에 붙여 무슨 종류의 실패인지 바로 보이게 한다. */
export function describeFailure(errorMessage: string): string {
  if (/HTTP 40[13]|SERVICE_KEY|SERVICE KEY|인증키|등록되지 않은/i.test(errorMessage)) {
    return "나라장터 조회 키 거절 — 키 확인 필요";
  }
  // 2026-10-06·07: GitHub 서버(미국)→나라장터 접속이 11분 동안 안 됨("fetch failed"). 대개 몇 시간 안에 풀린다.
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timed?\s?out|aborted|전체조회|HTTP 5\d\d/i.test(errorMessage)) {
    return "나라장터 접속 실패 — 대개 일시적";
  }
  if (/SMTP|EAUTH|Invalid login|메일/i.test(errorMessage)) return "이메일 발송 실패";
  if (/텔레그램|telegram/i.test(errorMessage)) return "텔레그램 발송 실패";
  return "예상하지 못한 오류";
}

export interface DevAlertInput {
  runMode: "weekly" | "daily" | "hourly";
  errorMessage: string;
  occurredAt: Date;
  /** GitHub 예비 실행(schedule)인지. 아니면 아침 실행이라 예비 실행이 다시 시도한다. */
  backupRun: boolean;
  /** GitHub Actions 실행 기록 주소 (로컬 실행이면 없음) */
  runUrl?: string;
}

const RUN_NAME: Record<DevAlertInput["runMode"], string> = {
  daily: "매일 새 입찰 공고 알림",
  weekly: "주간 보고",
  hourly: "매시간 새 공고 알림",
};

/** 웹훅 본문의 상한. Discord는 2000자라 원문을 그 안에 맞춘다. */
const MAX_CHARS = 1900;

export function buildDevAlertText(input: DevAlertInput): string {
  const consequence =
    input.runMode === "hourly"
      ? "다음 정시 실행이 다시 시도합니다."
      : input.backupRun
        ? "예비 실행도 실패 — 이번 보고가 빠졌습니다. 필요하면 workflow_dispatch(force=true)로 다시 보내세요."
        : "아침 실행 실패 — GitHub 예비 실행이 다시 시도합니다.";
  const head = [
    `[나라장터 모니터링] ${RUN_NAME[input.runMode]} 실패 · ${describeFailure(input.errorMessage)}`,
    input.occurredAt.toLocaleString("ko-KR"),
    consequence,
    ...(input.runUrl ? [input.runUrl] : []),
    "",
  ].join("\n");
  const room = MAX_CHARS - head.length - 8;
  const error = input.errorMessage.length > room ? `${input.errorMessage.slice(0, room)}\n…` : input.errorMessage;
  return `${head}\`\`\`\n${error}\n\`\`\``;
}

export function buildDevAlertPayload(webhookUrl: string, text: string): Record<string, string> {
  if (/discord(app)?\.com\/api\/webhooks/i.test(webhookUrl)) return { content: text };
  if (/hooks\.slack\.com/i.test(webhookUrl)) return { text };
  return { text, content: text };
}

/** 보내지 못해도 실행 결과를 바꾸지 않는다 — 로그에만 남긴다. */
export async function sendDevAlert(webhookUrl: string, input: DevAlertInput): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDevAlertPayload(webhookUrl, buildDevAlertText(input))),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    logger.info("개발자 웹훅 실패 알림 발송 완료");
  } catch (err) {
    // 웹훅 주소 자체가 비밀이라 오류에 주소를 싣지 않는다
    logger.error("개발자 웹훅 실패 알림 발송 실패", { error: toErrorMessage(err).replace(webhookUrl, "<webhook>") });
  }
}
