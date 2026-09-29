import "dotenv/config";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * 과거사업 코퍼스를 암호화해 저장소에 싣는다.
 *
 *   npm run corpus:encrypt   data/past-projects.json → corpus/past-projects.enc (커밋 대상)
 *   npm run corpus:decrypt   corpus/past-projects.enc → data/past-projects.json (GitHub Actions에서)
 *
 * 저장소가 공개라 평문 코퍼스(과업지시서 본문·담당자 연락처)는 올릴 수 없다. 그렇다고 빼 두면
 * Actions 알림에 싱크로율이 비므로, 암호문만 커밋하고 비밀번호는 CORPUS_PASSPHRASE
 * (로컬 .env, GitHub Secret)로 둔다. GitHub 문서의 "큰 시크릿 저장" 방식과 같다.
 *
 * 형식: "JCORP1" | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(JSON))
 * GCM이라 비밀번호가 틀리거나 파일이 깨지면 복호화 단계에서 바로 실패한다.
 */

const MAGIC = Buffer.from("JCORP1");
const PLAIN = resolve(process.env.CORPUS_PATH ?? "data/past-projects.json");
const SEALED = resolve("corpus/past-projects.enc");

function key(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function seal(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function open(sealed: Buffer, passphrase: string): Buffer {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("코퍼스 암호 파일 형식이 아닙니다");
  let at = MAGIC.length;
  const salt = sealed.subarray(at, (at += 16));
  const iv = sealed.subarray(at, (at += 12));
  const tag = sealed.subarray(at, (at += 16));
  const decipher = createDecipheriv("aes-256-gcm", key(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  return gunzipSync(Buffer.concat([decipher.update(sealed.subarray(at)), decipher.final()]));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const mode = process.argv[2];
  const passphrase = process.env.CORPUS_PASSPHRASE?.trim() ?? "";

  if (mode === "encrypt") {
    if (!passphrase) throw new Error("CORPUS_PASSPHRASE가 없습니다 (.env에 넣으세요)");
    const plain = readFileSync(PLAIN);
    const projects = JSON.parse(plain.toString("utf8")) as unknown[];
    mkdirSync(dirname(SEALED), { recursive: true });
    writeFileSync(SEALED, seal(plain, passphrase));
    console.log(`암호화 완료: 사업 ${projects.length}건 → ${SEALED}`);
  } else if (mode === "decrypt") {
    // 비밀번호나 암호 파일이 없으면 싱크로율 없이 돈다 — 알림 자체를 막을 이유는 없다 (loadCorpus.ts와 같은 원칙)
    if (!passphrase) {
      console.log("CORPUS_PASSPHRASE가 없어 코퍼스를 풀지 않습니다 — 싱크로율 없이 진행");
    } else if (!existsSync(SEALED)) {
      console.log(`${SEALED}이 없어 코퍼스를 풀지 않습니다 — 싱크로율 없이 진행`);
    } else {
      const plain = open(readFileSync(SEALED), passphrase);
      const projects = JSON.parse(plain.toString("utf8")) as unknown[];
      mkdirSync(dirname(PLAIN), { recursive: true });
      writeFileSync(PLAIN, plain);
      console.log(`복호화 완료: 사업 ${projects.length}건`);
    }
  } else {
    console.error("사용법: tsx scripts/corpusCrypto.ts encrypt|decrypt");
    process.exit(1);
  }
}
