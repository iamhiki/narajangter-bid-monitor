/**
 * 구글 서비스 계정 키 파일을 .env에 넣어주는 설정 스크립트.
 *
 *   npm run setup:sheets -- "C:/Users/WEBDEV/Downloads/키파일.json"
 *   npm run setup:sheets -- "C:/.../키파일.json" "https://docs.google.com/spreadsheets/d/1BxK.../edit"
 *
 * 서비스 계정 JSON은 여러 줄짜리 개인키를 품고 있어서 손으로 .env에 옮기다 깨지기 쉽다.
 * 이 스크립트가 한 줄로 변환해서 올바른 형식으로 써준다.
 *
 * 개인키는 화면에 절대 출력하지 않는다. 시트 공유에 필요한 client_email만 보여준다.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(process.cwd(), ".env");

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** 스프레드시트 URL에서 ID만 뽑는다. 이미 ID만 준 경우에는 그대로 돌려준다. */
function extractSheetId(input: string): string {
  const fromUrl = input.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (fromUrl) return fromUrl[1]!;
  if (/^[A-Za-z0-9_-]{20,}$/.test(input)) return input;
  fail(
    `시트 ID를 알아볼 수 없습니다: ${input}\n` +
      "  스프레드시트 주소 전체를 그대로 붙여넣거나, /d/ 와 /edit 사이 문자열만 넣으세요."
  );
}

/**
 * .env의 한 줄을 갈아끼운다.
 * "KEY=값" 과 "KEY = 값" 두 형태를 모두 받아준다 (dotenv가 둘 다 허용하므로
 * 사람이 편집한 .env에는 공백이 섞여 있는 경우가 흔하다).
 */
function setEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  return `${content}${needsNewline ? "\n" : ""}${line}\n`;
}

function main(): void {
  const [keyPathArg, sheetArg] = process.argv.slice(2);

  if (!keyPathArg) {
    fail(
      "서비스 계정 키 파일 경로가 필요합니다.\n" +
        '  사용법: npm run setup:sheets -- "C:/Users/WEBDEV/Downloads/키파일.json"\n' +
        '  시트 주소까지 함께: npm run setup:sheets -- "키파일.json" "https://docs.google.com/spreadsheets/d/.../edit"'
    );
  }

  const keyPath = path.resolve(keyPathArg);
  if (!existsSync(keyPath)) fail(`파일을 찾을 수 없습니다: ${keyPath}`);

  let raw: string;
  try {
    raw = readFileSync(keyPath, "utf8");
  } catch (err) {
    fail(`파일을 읽을 수 없습니다: ${err instanceof Error ? err.message : err}`);
  }

  let parsed: { type?: string; client_email?: string; private_key?: string; project_id?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("이 파일은 JSON이 아닙니다. 구글 클라우드에서 받은 서비스 계정 키(JSON)가 맞는지 확인하세요.");
  }

  if (!parsed.client_email || !parsed.private_key) {
    fail(
      "서비스 계정 키 파일이 아닙니다 (client_email 또는 private_key가 없습니다).\n" +
        "  Google Cloud Console → 사용자 인증 정보 → 서비스 계정 → 키 탭 → 키 추가 → JSON 으로 받은 파일이어야 합니다."
    );
  }

  // 한 줄로 압축. 작은따옴표로 감싸 넣을 거라 값 안에 작은따옴표가 있으면 형식이 깨진다.
  const oneLine = JSON.stringify(parsed);
  if (oneLine.includes("'")) {
    fail("키 JSON 안에 작은따옴표가 들어 있어 자동 설정이 안전하지 않습니다. 직접 넣어주세요.");
  }

  let env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  env = setEnvLine(env, "GOOGLE_SERVICE_ACCOUNT_JSON", `'${oneLine}'`);

  let sheetId: string | null = null;
  if (sheetArg) {
    sheetId = extractSheetId(sheetArg);
    env = setEnvLine(env, "FEEDBACK_SHEET_ID", sheetId);
  }

  writeFileSync(ENV_PATH, env, "utf8");

  console.log("\n✓ .env 설정 완료");
  console.log(`  GOOGLE_SERVICE_ACCOUNT_JSON  설정됨 (${oneLine.length}자)`);
  console.log(`  FEEDBACK_SHEET_ID            ${sheetId ?? "미설정 — 아래 안내 참고"}`);

  console.log("\n다음으로 할 일");
  console.log("  1. 스프레드시트를 열고 우측 상단 [공유]를 누르세요.");
  console.log("  2. 아래 주소를 붙여넣고 권한을 '편집자'로 지정하세요:");
  console.log(`\n       ${parsed.client_email}\n`);
  console.log("     ※ 서비스 계정은 본인 계정과 별개라, 본인이 만든 시트라도 공유해야 접근됩니다.");

  if (!sheetId) {
    console.log("  3. 시트 주소를 넣어 이 스크립트를 한 번 더 실행하세요:");
    console.log(`       npm run setup:sheets -- "${keyPathArg}" "시트주소"`);
    console.log("  4. npm run test:sheets 로 연결을 확인하세요.");
  } else {
    console.log("  3. npm run test:sheets 로 연결을 확인하세요.");
  }

  console.log("\n키 파일은 이제 필요 없습니다. 프로젝트 폴더 밖에 두거나 삭제하세요.");
}

main();
