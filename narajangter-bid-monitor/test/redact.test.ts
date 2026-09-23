import { describe, expect, it } from "vitest";
import { REDACTED, describeSecretPresence, redactSecrets } from "../src/redact.js";

describe("redactSecrets — 알고 있는 비밀값", () => {
  it("비밀값이 나타나는 모든 위치를 가린다", () => {
    const out = redactSecrets("키는 abcdef123 이고 다시 abcdef123", ["abcdef123"]);
    expect(out).toBe(`키는 ${REDACTED} 이고 다시 ${REDACTED}`);
  });

  it("정규식 특수문자가 든 비밀값도 문자 그대로 가린다", () => {
    const secret = "a+b.c(d)[e]*f?";
    expect(redactSecrets(`값=${secret}`, [secret])).toBe(`값=${REDACTED}`);
  });

  it("6자 미만은 건너뛴다 (흔한 단어와 겹쳐 멀쩡한 텍스트를 망가뜨리기 때문)", () => {
    expect(redactSecrets("이것은 abc 입니다", ["abc"])).toBe("이것은 abc 입니다");
  });

  it("undefined가 섞여 있어도 죽지 않는다", () => {
    expect(redactSecrets("평범한 문장", [undefined, ""])).toBe("평범한 문장");
  });

  it("여러 줄 비밀값이 literal 백슬래시-n 형태로 찍혀도 가린다", () => {
    const key = "line1\nline2\nline3-secret";
    const logged = "key=line1\\nline2\\nline3-secret";
    expect(redactSecrets(logged, [key])).toBe(`key=${REDACTED}`);
  });
});

describe("redactSecrets — 패턴 기반 보조 차단", () => {
  it("secrets 인자에 없어도 텔레그램 봇 토큰 형태를 가린다", () => {
    const out = redactSecrets(
      "https://api.telegram.org/bot8315747662:AAEsHS4AeQgMIfyV1a1pU_16V13H3mYFKIE/sendMessage",
      []
    );
    expect(out).not.toContain("AAEsHS4AeQgMIfyV1a1pU_16V13H3mYFKIE");
    expect(out).toContain(REDACTED);
  });

  it("PEM 개인키 블록을 통째로 가린다", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\nBgkqhkiG9w0B\n-----END PRIVATE KEY-----";
    const out = redactSecrets(`키:\n${pem}\n끝`, []);
    expect(out).not.toContain("MIIEvQIBADAN");
    expect(out).toBe(`키:\n${REDACTED}\n끝`);
  });

  it("서비스 계정 JSON의 private_key 필드를 가린다", () => {
    const json = '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n"}';
    const out = redactSecrets(json, []);
    expect(out).not.toContain("MIIE");
    // client_email은 비밀이 아니라 그대로 남아야 한다 (403 원인 파악에 필요하다)
    expect(out).toContain("a@b.iam.gserviceaccount.com");
  });

  it("공고번호처럼 숫자·콜론이 섞인 평범한 값은 건드리지 않는다", () => {
    const text = "공고번호 R26BK01695832 / 마감 2026-10-08 10:00:00 / 예산 350,000,000원";
    expect(redactSecrets(text, [])).toBe(text);
  });

  it("짧은 숫자:문자 조합은 토큰으로 오인하지 않는다", () => {
    expect(redactSecrets("포트 8080:http 로 연결", [])).toBe("포트 8080:http 로 연결");
  });
});

describe("describeSecretPresence", () => {
  it("값 대신 길이만 알려준다", () => {
    expect(describeSecretPresence("8315747662:AAEs")).toBe("설정됨 (15자)");
  });

  it("비어 있으면 미설정이라고 한다", () => {
    expect(describeSecretPresence(undefined)).toBe("미설정");
    expect(describeSecretPresence("   ")).toBe("미설정");
  });
});
