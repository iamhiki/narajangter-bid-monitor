/**
 * .env 설정 점검 — 값은 절대 출력하지 않는다.
 *
 *   npm run check:env
 *
 * "어떤 키가 채워져 있고 무엇이 비어 있는가"만 보여준다.
 * 설정을 확인한다고 .env를 터미널에 그대로 열거나 grep/sed로 훑으면
 * 토큰이 스크롤백·로그·화면공유에 그대로 남는다. 그럴 일이 없도록 이 스크립트를 쓴다.
 */
import "dotenv/config";
import { describeSecretPresence } from "../src/redact.js";

interface Entry {
  key: string;
  /** 비밀값이면 길이만, 아니면 값 자체를 보여준다 */
  secret: boolean;
  required: boolean;
  note?: string;
}

interface Group {
  title: string;
  entries: Entry[];
}

const GROUPS: Group[] = [
  {
    title: "나라장터 API",
    entries: [
      { key: "NARA_BID_SERVICE_KEY", secret: true, required: true },
      { key: "NARA_PRESTD_SERVICE_KEY", secret: true, required: false, note: "비우면 위 키를 재사용" },
    ],
  },
  {
    title: "이메일 (SMTP)",
    entries: [
      { key: "SMTP_HOST", secret: false, required: true },
      { key: "SMTP_PORT", secret: false, required: false },
      { key: "SMTP_USER", secret: false, required: true },
      { key: "SMTP_PASS", secret: true, required: true },
      { key: "SMTP_FROM", secret: false, required: false },
    ],
  },
  {
    title: "텔레그램 알림",
    entries: [
      { key: "TELEGRAM_BOT_TOKEN", secret: true, required: false },
      { key: "TELEGRAM_CHAT_IDS", secret: false, required: false, note: "둘 다 있어야 켜짐" },
      { key: "TELEGRAM_ENABLED", secret: false, required: false },
    ],
  },
  {
    title: "구글 시트 피드백",
    entries: [
      { key: "GOOGLE_SERVICE_ACCOUNT_JSON", secret: true, required: false },
      { key: "FEEDBACK_SHEET_ID", secret: false, required: false, note: "둘 다 있어야 켜짐" },
      { key: "FEEDBACK_SHEET_NAME", secret: false, required: false },
    ],
  },
  {
    title: "실행 옵션",
    entries: [
      { key: "DRY_RUN", secret: false, required: false },
      { key: "LOOKBACK_DAYS", secret: false, required: false },
      { key: "LOG_LEVEL", secret: false, required: false },
      { key: "SEND_EMPTY_REPORT", secret: false, required: false },
    ],
  },
];

/** 비밀값이 아닌 값도 통째로 찍지 않고 길면 줄인다 (SMTP_FROM 등에 개인정보가 섞일 수 있다). */
function describePlain(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "미설정";
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}

function main(): void {
  const problems: string[] = [];

  for (const group of GROUPS) {
    console.log(`\n[${group.title}]`);
    for (const entry of group.entries) {
      const raw = process.env[entry.key];
      const filled = Boolean(raw?.trim());
      const shown = entry.secret ? describeSecretPresence(raw) : describePlain(raw);
      const mark = filled ? "✓" : entry.required ? "✗" : "·";
      const note = entry.note ? `  — ${entry.note}` : "";
      console.log(`  ${mark} ${entry.key.padEnd(30)} ${shown}${note}`);
      if (entry.required && !filled) problems.push(entry.key);
    }
  }

  // 짝으로 채워야 하는 항목들 — 한쪽만 있으면 loadEnv()가 실행을 막는다.
  const pairs: Array<[string, string, string]> = [
    ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_IDS", "텔레그램"],
    ["GOOGLE_SERVICE_ACCOUNT_JSON", "FEEDBACK_SHEET_ID", "구글 시트"],
  ];

  const warnings: string[] = [];
  for (const [a, b, label] of pairs) {
    const hasA = Boolean(process.env[a]?.trim());
    const hasB = Boolean(process.env[b]?.trim());
    if (hasA !== hasB) {
      warnings.push(`${label}: ${hasA ? a : b}만 채워져 있습니다. 둘 다 있어야 동작합니다.`);
    } else if (!hasA) {
      warnings.push(`${label}: 미설정 — 이 기능은 건너뜁니다(오류는 아닙니다).`);
    }
  }

  console.log("");
  if (warnings.length > 0) {
    console.log("참고:");
    for (const w of warnings) console.log(`  · ${w}`);
    console.log("");
  }

  if (problems.length > 0) {
    console.error(`✗ 필수 항목 ${problems.length}개가 비어 있습니다: ${problems.join(", ")}`);
    process.exit(1);
  }
  console.log("✓ 필수 항목은 모두 채워져 있습니다.");
}

main();
