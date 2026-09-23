/**
 * 텔레그램 봇 연결 확인용 단독 스크립트.
 *
 *   npm run test:telegram
 *
 * 하는 일 두 가지:
 *  1) getUpdates로 "봇에게 말을 건 적 있는 대화"들의 chat_id를 출력한다.
 *     → .env의 TELEGRAM_CHAT_IDS에 무엇을 넣어야 하는지 여기서 확인한다.
 *  2) TELEGRAM_CHAT_IDS가 이미 채워져 있으면 그 대상에게 테스트 메시지를 실제로 보낸다.
 *
 * 나라장터 API를 전혀 건드리지 않으므로 텔레그램 설정만 따로 검증할 수 있다.
 */
import "dotenv/config";
import { sendTelegramReport } from "../src/notify/telegram.js";
import { redactSecrets } from "../src/redact.js";
import type { ReportInput } from "../src/report/buildReport.js";
import type { MatchedNotice } from "../src/matching/types.js";

const botToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const chatIds = (process.env.TELEGRAM_CHAT_IDS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter((v) => v !== "");

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function callApi(method: string): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`);
  const raw = await res.text();
  // 토큰이 URL에 들어가므로 오류 출력에 URL을 넣지 않는다.
  if (!res.ok) fail(`텔레그램 ${method} 실패 (HTTP ${res.status}): ${redactSecrets(raw.slice(0, 300), [botToken])}`);
  return JSON.parse(raw);
}

/** 미리보기용 가짜 공고 — 실제 API를 호출하지 않고 메시지 렌더링까지 확인하기 위한 것 */
function sampleMatch(): MatchedNotice {
  return {
    notice: {
      noticeNo: "R26BK00000000",
      title: "[연결 테스트] 정선군 복합문화센터 공간디자인 및 전시물 제작 설치",
      institution: "정선군",
      businessType: "용역",
      sourceType: "본공고",
      postedAt: null,
      deadline: "2026-12-31",
      budgetAmount: 350000000,
      detailUrl: "https://www.g2b.go.kr",
      industryText: null,
      productClsfcNo: null,
      productClsfcName: null,
      bidMethod: "협상에 의한 계약",
      raw: {},
    },
    matchedProductCodes: [{ code: "6010989901", name: "실물모형및전시물" }],
    matchedIndustryCodes: [],
    matchedKeywords: ["전시"],
    confidence: "강력추천",
    overseasVenueFlag: null,
  };
}

async function main(): Promise<void> {
  if (!botToken) {
    fail("TELEGRAM_BOT_TOKEN이 비어 있습니다. @BotFather에서 봇을 만들고 .env에 토큰을 넣으세요.");
  }

  // 1) 봇 자체가 살아 있는지
  const me = (await callApi("getMe")) as { ok: boolean; result?: { username?: string; first_name?: string } };
  if (!me.ok) fail("getMe 응답이 ok=false입니다. 토큰이 올바른지 확인하세요.");
  console.log(`✓ 봇 연결 성공: @${me.result?.username ?? "?"} (${me.result?.first_name ?? ""})`);

  const botUsername = me.result?.username ?? "봇아이디";

  // 2) 웹훅이 걸려 있으면 getUpdates로는 아무것도 못 받는다 (둘은 배타적이다).
  const webhook = (await callApi("getWebhookInfo")) as {
    result?: { url?: string; pending_update_count?: number };
  };
  if (webhook.result?.url) {
    fail(
      `이 봇에 웹훅이 설정돼 있어 getUpdates로 chat_id를 읽을 수 없습니다 (${webhook.result.url}).\n` +
        `  해제: curl "https://api.telegram.org/bot<토큰>/deleteWebhook"`
    );
  }

  // 3) 이 봇이 받은 대화 목록 → chat_id 찾기.
  //    message만 보면 놓치는 경우가 있다 — 그룹에 봇을 초대하기만 하면 message 없이
  //    my_chat_member만 오고, 채널은 channel_post로 온다.
  interface Chat {
    id?: number;
    type?: string;
    title?: string;
    username?: string;
    first_name?: string;
  }
  interface Update {
    message?: { chat?: Chat };
    edited_message?: { chat?: Chat };
    channel_post?: { chat?: Chat };
    my_chat_member?: { chat?: Chat };
    callback_query?: { message?: { chat?: Chat } };
  }

  const updates = (await callApi("getUpdates")) as { ok: boolean; result?: Update[] };
  const rawCount = updates.result?.length ?? 0;

  const seen = new Map<number, string>();
  for (const u of updates.result ?? []) {
    const chats = [
      u.message?.chat,
      u.edited_message?.chat,
      u.channel_post?.chat,
      u.my_chat_member?.chat,
      u.callback_query?.message?.chat,
    ];
    for (const chat of chats) {
      if (chat?.id === undefined) continue;
      const label = chat.title ?? chat.username ?? chat.first_name ?? "(이름없음)";
      seen.set(chat.id, `${label} [${chat.type ?? "?"}]`);
    }
  }

  console.log(`\n--- 이 봇이 받은 대화 (chat_id) · 수신 이벤트 ${rawCount}건 ---`);
  if (seen.size === 0) {
    console.log("(없음)\n");
    console.log("개인으로 받으려면:");
    console.log(`  1. 텔레그램에서 https://t.me/${botUsername} 열기`);
    console.log("  2. [시작] 버튼을 누르거나 아무 메시지나 1회 전송");
    console.log("");
    console.log("그룹으로 받으려면:");
    console.log("  1. 그룹에 봇 초대");
    console.log(`  2. 그룹에서 "/start@${botUsername}" 이라고 전송`);
    console.log("     ※ 봇은 기본적으로 '개인정보 보호 모드'라 그룹의 일반 대화는 못 봅니다.");
    console.log("       봇을 향한 명령(/명령@봇아이디)만 전달되므로 위 형식 그대로 보내야 합니다.");
    console.log("       (BotFather에서 /setprivacy → Disable 로 끌 수도 있습니다)");
    console.log("");
    console.log("보낸 뒤 이 스크립트를 다시 실행하세요.");
    console.log("※ 텔레그램은 이 기록을 24시간만 보관합니다. 오래 전에 보냈다면 다시 보내세요.");
  } else {
    for (const [id, label] of seen) {
      console.log(`  ${id}  ${label}`);
    }
    console.log("\n위 숫자를 .env의 TELEGRAM_CHAT_IDS에 넣으세요 (쉼표로 여러 개 가능).");
  }

  // 3) 이미 설정돼 있으면 실제 발송까지 해본다
  if (chatIds.length === 0) {
    console.log("\nTELEGRAM_CHAT_IDS가 비어 있어 테스트 발송은 건너뜁니다.");
    return;
  }

  const now = new Date();
  const input: ReportInput = {
    generatedAt: now,
    window: { begin: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now },
    bid: { matches: [sampleMatch()], failures: [] },
    preStandard: { matches: [], failures: [] },
  };

  console.log(`\n테스트 메시지 발송 중... (대상 ${chatIds.length}곳)`);
  await sendTelegramReport(input, { botToken, chatIds });
  console.log("✓ 발송 완료 — 텔레그램 앱에서 확인하세요.");
}

main().catch((err) => {
  fail(redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err), [botToken]));
});
