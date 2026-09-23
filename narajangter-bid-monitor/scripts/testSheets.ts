/**
 * 구글 시트 연결 확인용 단독 스크립트.
 *
 *   npm run test:sheets
 *
 * 나라장터 API를 건드리지 않고, 가짜 공고 1건으로 시트 연결·헤더 생성·중복 제거까지
 * 실제로 돌려본다. 두 번 연속 실행하면 두 번째는 "건너뜀 1건"이 나와야 정상이다.
 */
import "dotenv/config";
import { appendMatchesToFeedbackSheet } from "../src/sheets/feedbackSheet.js";
import { redactSecrets } from "../src/redact.js";
import type { MatchedNotice } from "../src/matching/types.js";

const serviceAccountJson = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
const spreadsheetId = (process.env.FEEDBACK_SHEET_ID ?? "").trim();
const sheetName = (process.env.FEEDBACK_SHEET_NAME ?? "").trim() || "피드백";

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** 연결 확인 전용 가짜 공고 — 실제 공고번호와 겹치지 않도록 TEST- 접두사를 쓴다. */
function sampleMatch(): MatchedNotice {
  return {
    notice: {
      noticeNo: "TEST-CONNECTION-0001",
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
      bidMethod: "협상에의한계약-협상에 의한 낙찰자 결정",
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
  if (!serviceAccountJson) {
    fail("GOOGLE_SERVICE_ACCOUNT_JSON이 비어 있습니다. 서비스 계정 키 JSON을 .env에 넣으세요.");
  }
  if (!spreadsheetId) {
    fail("FEEDBACK_SHEET_ID가 비어 있습니다. 스프레드시트 URL의 /d/ 와 /edit 사이 문자열입니다.");
  }

  // 시트를 어느 계정과 공유해야 하는지 먼저 알려준다 — 403의 대부분이 이 공유 누락이다.
  try {
    const parsed = JSON.parse(serviceAccountJson) as { client_email?: string };
    console.log(`서비스 계정: ${parsed.client_email ?? "(client_email 없음)"}`);
    console.log("→ 이 주소가 스프레드시트에 '편집자'로 공유돼 있어야 합니다.\n");
  } catch {
    fail("GOOGLE_SERVICE_ACCOUNT_JSON이 올바른 JSON이 아닙니다.");
  }

  console.log(`시트 ${spreadsheetId} / 탭 "${sheetName}"에 테스트 행을 기록합니다...`);
  const result = await appendMatchesToFeedbackSheet([sampleMatch()], new Date(), {
    serviceAccountJson,
    spreadsheetId,
    sheetName,
  });

  console.log(`\n✓ 완료 — 추가 ${result.appended}건 / 건너뜀 ${result.skipped}건`);
  if (result.skipped > 0) {
    console.log("  (이미 있는 공고번호를 건너뛴 것이므로 중복 제거가 정상 동작한다는 뜻입니다.)");
  }
  console.log(`  https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
  console.log("\n확인이 끝나면 시트에서 TEST-CONNECTION-0001 행을 지우세요.");
}

main().catch((err) => {
  fail(redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err), [serviceAccountJson]));
});
