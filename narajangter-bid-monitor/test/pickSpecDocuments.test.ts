import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pickSpecDocuments } from "../src/corpus/scanArchive.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function project(files: string[]): string {
  dir = mkdtempSync(join(tmpdir(), "corpus-"));
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

describe("pickSpecDocuments", () => {
  it("22~26년도처럼 사업 폴더에 바로 있는 문서를 고른다", () => {
    const p = project(["20240904_제안요청서_강원_v1.hwp", "20241022_사업수행능력평가서_v1.pdf", "20240901_과업지시서_v1.hwp"]);
    expect(pickSpecDocuments(p).map((f) => basename(f))).toEqual(["20240901_과업지시서_v1.hwp", "20240904_제안요청서_강원_v1.hwp"]);
  });

  it("17~21년도처럼 문서 종류별 하위 폴더에 있으면 폴더 이름으로 종류를 판별한다", () => {
    const p = project([
      "제안요청서/20170615_20170618791-00_1497506437455_[첨부]__홍보_및_접견공간_v1.hwp",
      "과업지시서/20170811_20170725771-02_1501475256617_v1.hwp",
      "사업수행능력평가/20191119_(주)지일_원주_거돈사지~제안요청서_제출(191112)_v1.hwp",
    ]);
    expect(pickSpecDocuments(p).map((f) => basename(f))).toEqual([
      "20170811_20170725771-02_1501475256617_v1.hwp",
      "20170615_20170618791-00_1497506437455_[첨부]__홍보_및_접견공간_v1.hwp",
    ]);
  });
});
