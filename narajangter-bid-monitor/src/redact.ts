/** 로그/알림 메일 등 외부로 나가는 텍스트에서 비밀값이 실수로 노출되는 것을 막기 위한 마지막 방어선 */

export const REDACTED = "***REDACTED***";

/**
 * 호출부가 비밀값을 넘겨주지 않았을 때를 대비한 패턴 기반 보조 차단.
 *
 * 새 비밀값을 추가하면서 index.ts의 secrets 배열에 넣는 걸 빠뜨리는 실수가 실제로
 * 일어나기 때문에(그때는 아무 경고 없이 원문이 그대로 로그에 남는다), 형태만으로
 * 알아볼 수 있는 것들은 값을 몰라도 가린다.
 *
 * 여기 없는 값(예: data.go.kr 서비스키)은 형태가 일반 문자열과 구분되지 않아
 * 패턴으로 잡으면 멀쩡한 텍스트까지 훼손된다 — 그런 값은 반드시 secrets 인자로 넘겨야 한다.
 */
const SECRET_PATTERNS: RegExp[] = [
  // 텔레그램 봇 토큰: 8~12자리 숫자 + ':' + 30자 이상의 토큰 문자열.
  // \b를 쓰면 URL의 ".../bot8315747662:AAE..." 처럼 앞에 글자가 붙은 형태를 놓친다
  // (토큰이 노출되는 경로가 바로 이 URL이라 반드시 잡아야 한다). 대신 앞뒤로
  // 숫자/토큰문자가 이어지지 않는지만 본다.
  /(?<!\d)\d{8,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/g,
  // PEM 개인키 블록 (실제 줄바꿈 / literal \n 양쪽 모두)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|[^"])*?-----END [A-Z ]*PRIVATE KEY-----(?:\\n)?/g,
  // 서비스 계정 JSON을 통째로 찍은 경우의 private_key 필드
  /"private_key"\s*:\s*"[^"]*"/g,
];

/**
 * text에서 비밀값을 가린다.
 *
 * @param secrets 알고 있는 비밀값들. 6자 미만은 흔한 단어와 겹쳐 멀쩡한 텍스트를
 *                망가뜨릴 수 있어 건너뛴다.
 */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  let result = text;

  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    // split/join을 쓰는 이유: 비밀값에 정규식 특수문자가 들어 있어도 문자 그대로 매칭된다.
    result = result.split(secret).join(REDACTED);

    // 서비스 계정 JSON처럼 여러 줄짜리 값은 .env에서 literal \n으로 들어오고
    // 코드 안에서는 실제 줄바꿈으로 바뀌어 있어, 위 그대로 비교로는 안 걸린다.
    if (secret.includes("\n")) {
      result = result.split(secret.replace(/\n/g, "\\n")).join(REDACTED);
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }

  return result;
}

/**
 * 환경변수 값을 사람에게 보여줄 때 쓰는 요약 표기.
 * 값 자체는 절대 드러내지 않고 "설정됨(길이 46)" 정도만 알려준다.
 */
export function describeSecretPresence(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "미설정";
  return `설정됨 (${trimmed.length}자)`;
}
