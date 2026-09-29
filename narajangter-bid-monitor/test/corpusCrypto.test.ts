import { describe, expect, it } from "vitest";
import { open, seal } from "../scripts/corpusCrypto.js";

describe("corpusCrypto", () => {
  const plain = Buffer.from(JSON.stringify([{ id: "2017/국립중앙과학관", body: "과업지시서 본문" }]));

  it("암호화한 코퍼스를 같은 비밀번호로 되돌린다", () => {
    const sealed = seal(plain, "pw");
    expect(sealed.includes(Buffer.from("과업지시서"))).toBe(false);
    expect(open(sealed, "pw").equals(plain)).toBe(true);
  });

  it("비밀번호가 틀리면 실패한다", () => {
    expect(() => open(seal(plain, "pw"), "wrong")).toThrow();
  });
});
