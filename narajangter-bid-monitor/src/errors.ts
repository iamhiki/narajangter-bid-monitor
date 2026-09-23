/** 환경변수/설정 파일이 잘못되었을 때 발생 (실행 즉시 중단되어야 하는 오류) */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** data.go.kr API 호출/응답 파싱 실패 */
export class ApiError extends Error {
  readonly operation: string;
  override readonly cause?: unknown;

  constructor(operation: string, message: string, cause?: unknown) {
    super(`[${operation}] ${message}`);
    this.name = "ApiError";
    this.operation = operation;
    this.cause = cause;
  }
}

/** data.go.kr이 정상 응답 포맷으로 명시적 오류를 반환한 경우 */
export class ApiResultError extends ApiError {
  readonly resultCode: string;

  constructor(operation: string, resultCode: string, resultMsg: string) {
    super(operation, `resultCode=${resultCode} resultMsg=${resultMsg}`);
    this.name = "ApiResultError";
    this.resultCode = resultCode;
  }
}

/** 텔레그램 발송 실패 */
export class TelegramError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TelegramError";
    this.cause = cause;
  }
}

/** 이메일 발송 실패 */
export class EmailError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "EmailError";
    this.cause = cause;
  }
}

/** 구글 시트 기록 실패 */
export class SheetsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SheetsError";
    this.cause = cause;
  }
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}
