import { describe, expect, it } from "vitest";
import { asksFor, buildAnswer } from "../src/net/mdns.js";

/** "jiil-bid.local A?" 질의 패킷 */
function query(name: string, type = 1, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4);
  const labels = Buffer.concat([...name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, labels, tail]);
}

describe("사내망 이름 알리기 (mDNS)", () => {
  it("우리 이름의 IPv4 질의에만 답한다 (대소문자 무시)", () => {
    expect(asksFor(query("JIIL-BID.local"), "jiil-bid.local")).toEqual({ id: 0x1234 });
    expect(asksFor(query("printer.local"), "jiil-bid.local")).toBeNull();
    expect(asksFor(query("jiil-bid.local", 28), "jiil-bid.local")).toBeNull(); // AAAA
    expect(asksFor(Buffer.from([1, 2, 3]), "jiil-bid.local")).toBeNull();
  });

  it("응답 끝 4바이트가 이 PC의 IP다. 일회성 질의에는 ID와 질문을 되돌려 준다", () => {
    const multicast = buildAnswer("jiil-bid.local", "192.168.0.45");
    expect([...multicast.subarray(-4)]).toEqual([192, 168, 0, 45]);
    expect(multicast.readUInt16BE(0)).toBe(0);
    expect(multicast.readUInt16BE(4)).toBe(0);

    const legacy = buildAnswer("jiil-bid.local", "192.168.0.45", { id: 0x1234, legacy: true });
    expect(legacy.readUInt16BE(0)).toBe(0x1234);
    expect(legacy.readUInt16BE(4)).toBe(1);
    expect(asksFor(legacy, "jiil-bid.local")).toBeNull(); // 응답은 질의로 보지 않는다
  });
});
