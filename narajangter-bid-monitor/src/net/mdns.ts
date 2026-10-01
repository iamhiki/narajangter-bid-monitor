import { createSocket, type RemoteInfo } from "node:dgram";

/**
 * 사내망에 이름을 알린다 — 팀원이 IP 대신 http://jiil-bid.local 로 들어올 수 있게.
 *
 * 회사에 내부 DNS 서버가 없고(공유기가 KT 공용 DNS를 나눠 준다) 이 PC는 DHCP라 IP가 바뀔 수 있다.
 * 프린터·공유기가 이름을 알리는 방식(mDNS, RFC 6762)으로 "jiil-bid.local이 누구냐"는 물음에 이 PC의
 * 지금 IP로 답한다. Windows 10 이상·macOS·iOS·Android 12 이상은 .local 이름을 이렇게 찾는다.
 * A(IPv4) 질의에만 답한다 — 다른 질의는 Windows 자체 응답기가 그대로 처리한다.
 */
const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_ANY = 255;

interface Question {
  name: string;
  type: number;
  end: number;
}

/** 질문 하나를 읽는다. 압축 포인터(0xC0)는 질의에 거의 없지만 만나면 따라간다 */
function readName(buf: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let pos = offset;
  let end = -1;
  for (let guard = 0; guard < 64; guard++) {
    const len = buf[pos];
    if (len === undefined) throw new Error("짧은 패킷");
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1]!;
      continue;
    }
    labels.push(buf.toString("utf8", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join(".").toLowerCase(), end: end >= 0 ? end : pos };
}

function parseQuestions(buf: Buffer): { id: number; isResponse: boolean; questions: Question[] } {
  const id = buf.readUInt16BE(0);
  const isResponse = (buf.readUInt16BE(2) & 0x8000) !== 0;
  const qd = buf.readUInt16BE(4);
  const questions: Question[] = [];
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const { name, end } = readName(buf, pos);
    questions.push({ name, type: buf.readUInt16BE(end), end: end + 4 });
    pos = end + 4;
  }
  return { id, isResponse, questions };
}

function encodeName(name: string): Buffer {
  return Buffer.concat([...name.split(".").map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
}

/** A 레코드 응답. legacy(5353이 아닌 포트에서 온 일회성 질의)면 질문을 되돌려 주고 ID를 맞춘다 */
export function buildAnswer(name: string, ip: string, opts: { id?: number; legacy?: boolean } = {}): Buffer {
  const nameBuf = encodeName(name);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.legacy ? (opts.id ?? 0) : 0, 0);
  header.writeUInt16BE(0x8400, 2); // 응답 + 권한 있음
  header.writeUInt16BE(opts.legacy ? 1 : 0, 4);
  header.writeUInt16BE(1, 6);
  const question = opts.legacy ? Buffer.concat([nameBuf, Buffer.from([0, TYPE_A, 0, 1])]) : Buffer.alloc(0);
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(TYPE_A, 0);
  rr.writeUInt16BE(opts.legacy ? 0x0001 : 0x8001, 2); // IN, 멀티캐스트면 캐시 갱신 표시
  rr.writeUInt32BE(120, 4);
  rr.writeUInt16BE(4, 8);
  const addr = Buffer.from(ip.split(".").map(Number));
  return Buffer.concat([header, question, nameBuf, rr, addr]);
}

/** 이 질의가 우리 이름의 IPv4 주소를 묻는가 */
export function asksFor(buf: Buffer, fqdn: string): { id: number } | null {
  try {
    const { id, isResponse, questions } = parseQuestions(buf);
    if (isResponse) return null;
    return questions.some((q) => q.name === fqdn && (q.type === TYPE_A || q.type === TYPE_ANY)) ? { id } : null;
  } catch {
    return null;
  }
}

/**
 * hostname: "jiil-bid" → jiil-bid.local. getIp는 답할 때마다 부른다 — DHCP로 IP가 바뀌어도 새 주소로 답한다.
 * 실패해도(포트를 못 잡는 등) 서버는 그대로 돈다. IP 주소로는 계속 들어올 수 있다.
 */
export function announceName(hostname: string, getIp: () => string, log: (msg: string) => void = () => {}): () => void {
  const fqdn = `${hostname.toLowerCase()}.local`;
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("error", (err) => {
    log(`이름 알리기(${fqdn}) 실패 — IP 주소로는 계속 접속됩니다: ${err.message}`);
    socket.close();
  });
  socket.on("message", (msg: Buffer, rinfo: RemoteInfo) => {
    const hit = asksFor(msg, fqdn);
    if (!hit) return;
    const ip = getIp();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return;
    const legacy = rinfo.port !== MDNS_PORT;
    const answer = buildAnswer(fqdn, ip, { id: hit.id, legacy });
    if (legacy) socket.send(answer, rinfo.port, rinfo.address);
    else socket.send(answer, MDNS_PORT, MDNS_ADDR);
  });
  socket.bind(MDNS_PORT, () => {
    try {
      socket.addMembership(MDNS_ADDR, getIp());
    } catch {
      socket.addMembership(MDNS_ADDR);
    }
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(true);
  });
  return () => socket.close();
}
