import { JWT } from "google-auth-library";
import { SheetsError, toErrorMessage } from "../errors.js";
import { logger } from "../logger.js";
import type { MatchedNotice } from "../matching/types.js";
import {
  FEEDBACK_HEADER,
  SYSTEM_COLUMN_COUNT,
  VERDICT_OPTIONS,
  selectNewRows,
  type FeedbackRow,
} from "./feedbackRow.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/** 헤더 A~V (22열). 열을 추가하면 이 값도 함께 늘려야 한다. */
const LAST_COLUMN = "V";
/** "판정" 열(19번째 = S)의 0-based 인덱스. 드롭다운을 걸 위치. 시스템 열이 늘면 함께 민다. */
const VERDICT_COLUMN_INDEX = 18;

export interface FeedbackSheetOptions {
  /** 서비스 계정 키 JSON 전문 */
  serviceAccountJson: string;
  spreadsheetId: string;
  sheetName: string;
}

interface ServiceAccount {
  client_email?: string;
  private_key?: string;
}

function parseServiceAccount(raw: string): { email: string; key: string } {
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw) as ServiceAccount;
  } catch (err) {
    throw new SheetsError(
      "GOOGLE_SERVICE_ACCOUNT_JSON을 JSON으로 읽을 수 없습니다. 서비스 계정 키 파일 내용을 통째로 넣었는지 확인하세요.",
      err
    );
  }

  const email = parsed.client_email?.trim();
  const key = parsed.private_key;
  if (!email || !key) {
    throw new SheetsError("서비스 계정 JSON에 client_email 또는 private_key가 없습니다.");
  }

  // .env 한 줄에 넣으면 줄바꿈이 literal 백슬래시+n 두 글자로 들어온다. 둘 다 받아준다.
  return { email, key: key.includes("\\n") ? key.replace(/\\n/g, "\n") : key };
}

async function getAccessToken(options: FeedbackSheetOptions): Promise<string> {
  const { email, key } = parseServiceAccount(options.serviceAccountJson);
  const auth = new JWT({ email, key, scopes: SCOPES });

  // getAccessToken()은 버전에 따라 문자열이 아니라 { token, res } 객체를 돌려준다.
  // 객체를 String()으로 변환하면 "[object Object]"가 되어 헤더에 그대로 실리고,
  // 구글은 401 UNAUTHENTICATED로 응답한다 (권한 문제처럼 보이지만 실제로는 토큰이 깨진 것).
  const result = (await auth.getAccessToken()) as string | { token?: string | null } | null;
  const token = typeof result === "string" ? result : result?.token;

  if (!token) throw new SheetsError("구글 액세스 토큰을 발급받지 못했습니다.");
  return token;
}

async function callSheets(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const res = await fetch(`${SHEETS_API}/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    // 403은 거의 항상 "스프레드시트를 서비스 계정과 공유하지 않음"이라 따로 안내한다.
    const hint =
      res.status === 403
        ? " — 스프레드시트를 서비스 계정 이메일에 '편집자'로 공유했는지 확인하세요."
        : "";
    throw new SheetsError(`구글 시트 API 실패 (HTTP ${res.status})${hint}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** 탭이 없으면 만들고, 그 탭의 내부 sheetId를 돌려준다. */
async function ensureSheetTab(token: string, options: FeedbackSheetOptions): Promise<number> {
  const meta = (await callSheets(token, `${options.spreadsheetId}?fields=sheets.properties`)) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };

  const found = meta.sheets?.find((s) => s.properties?.title === options.sheetName);
  if (found?.properties?.sheetId !== undefined) return found.properties.sheetId;

  const created = (await callSheets(token, `${options.spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: { requests: [{ addSheet: { properties: { title: options.sheetName } } }] },
  })) as { replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }> };

  const sheetId = created.replies?.[0]?.addSheet?.properties?.sheetId;
  if (sheetId === undefined) {
    throw new SheetsError(`시트 탭 "${options.sheetName}" 생성에 실패했습니다.`);
  }

  logger.info("피드백 시트 탭 생성됨", { sheetName: options.sheetName });
  return sheetId;
}

/** 1행이 비어 있으면 헤더를 쓰고, 고정·굵게·판정 드롭다운까지 함께 설정한다. */
async function ensureHeader(
  token: string,
  options: FeedbackSheetOptions,
  sheetId: number
): Promise<void> {
  const range = `${encodeURIComponent(options.sheetName)}!A1:${LAST_COLUMN}1`;
  const current = (await callSheets(token, `${options.spreadsheetId}/values/${range}`)) as {
    values?: string[][];
  };
  if (current.values && current.values.length > 0 && (current.values[0]?.length ?? 0) > 0) return;

  await callSheets(token, `${options.spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    body: { values: [[...FEEDBACK_HEADER]] },
  });

  // 서식은 실패해도 데이터 적재를 막을 이유가 없다 (권한 범위가 좁은 경우 등).
  try {
    await callSheets(token, `${options.spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          {
            setDataValidation: {
              range: {
                sheetId,
                startRowIndex: 1,
                startColumnIndex: VERDICT_COLUMN_INDEX,
                endColumnIndex: VERDICT_COLUMN_INDEX + 1,
              },
              rule: {
                condition: {
                  type: "ONE_OF_LIST",
                  values: VERDICT_OPTIONS.map((v) => ({ userEnteredValue: v })),
                },
                showCustomUi: true,
                // strict를 켜면 다른 값을 아예 못 넣는데, 담당자가 예외 상황을 적고 싶을 수
                // 있으므로 경고만 띄우고 입력 자체는 막지 않는다.
                strict: false,
              },
            },
          },
        ],
      },
    });
  } catch (err) {
    logger.warn("피드백 시트 서식 설정 실패 (데이터 적재는 계속합니다)", {
      error: toErrorMessage(err),
    });
  }

  logger.info("피드백 시트 헤더 생성됨", {
    sheetName: options.sheetName,
    열수: FEEDBACK_HEADER.length,
  });
}

/** A열(공고번호)을 전부 읽어 이미 기록된 공고 집합을 만든다. */
async function fetchExistingNoticeNos(
  token: string,
  options: FeedbackSheetOptions
): Promise<Set<string>> {
  const range = `${encodeURIComponent(options.sheetName)}!A2:A`;
  const res = (await callSheets(token, `${options.spreadsheetId}/values/${range}`)) as {
    values?: string[][];
  };

  const set = new Set<string>();
  for (const row of res.values ?? []) {
    const value = row[0]?.trim();
    if (value) set.add(value);
  }
  return set;
}

async function appendRows(
  token: string,
  options: FeedbackSheetOptions,
  rows: FeedbackRow[]
): Promise<void> {
  const range = `${encodeURIComponent(options.sheetName)}!A1`;
  await callSheets(
    token,
    `${options.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values: rows } }
  );
}

export interface AppendResult {
  appended: number;
  /** 이미 시트에 있어 건너뛴 건수 (조회 기간이 실행 주기보다 길어 매 실행마다 발생한다) */
  skipped: number;
}

/**
 * 이번 사이클의 매칭 결과를 피드백 시트에 추가한다.
 *
 * 담당자가 이미 판정해둔 행은 절대 건드리지 않는다 — 새 행을 아래에 덧붙이기만 하고,
 * 공고번호가 이미 있으면 건너뛴다. 시스템은 A~R열(SYSTEM_COLUMN_COUNT개)만 쓰고
 * S열 이후(판정/오판사유/판정자/판정일)는 담당자 몫으로 비워둔다.
 */
export async function appendMatchesToFeedbackSheet(
  matches: MatchedNotice[],
  collectedAt: Date,
  options: FeedbackSheetOptions
): Promise<AppendResult> {
  const token = await getAccessToken(options);
  const sheetId = await ensureSheetTab(token, options);
  await ensureHeader(token, options, sheetId);

  const existing = await fetchExistingNoticeNos(token, options);
  const { rows, skipped } = selectNewRows(matches, existing, collectedAt);

  if (rows.length === 0) {
    logger.info("피드백 시트에 추가할 새 공고가 없습니다", { 건너뜀: skipped });
    return { appended: 0, skipped };
  }

  // 행 길이가 시스템 열 개수와 어긋나면 담당자 입력란까지 덮어쓰게 되므로 여기서 잡는다.
  for (const row of rows) {
    if (row.length !== SYSTEM_COLUMN_COUNT) {
      throw new SheetsError(
        `행 길이(${row.length})가 시스템 열 개수(${SYSTEM_COLUMN_COUNT})와 다릅니다 — 담당자 입력란을 덮어쓸 수 있어 중단합니다.`
      );
    }
  }

  await appendRows(token, options, rows);
  logger.info("피드백 시트 기록 완료", {
    추가: rows.length,
    건너뜀: skipped,
    sheetName: options.sheetName,
  });
  return { appended: rows.length, skipped };
}
