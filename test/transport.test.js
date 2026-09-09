/**
 * P2P 전송 암호화 — 핸드셰이크, 프레임, 신원 고정.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const Transport = require("../src/transport");

const NET = "limcoin/test/1";
const socket = () => ({ sent: [] });

// 두 쪽이 서로 핸드셰이크를 주고받게 한다
const pair = (network = NET, pinA, pinB) => {
  const a = socket();
  const b = socket();
  const helloA = Transport.startSession(a, network);
  const helloB = Transport.startSession(b, network);
  const atB = Transport.unwrap(b, helloA, network, pinB);
  const atA = Transport.unwrap(a, helloB, network, pinA);
  return { a, b, helloA, helloB, atA, atB };
};

const withMode = (value, run) => {
  const before = process.env.LIMCOIN_ENCRYPT;
  process.env.LIMCOIN_ENCRYPT = value;
  try {
    return run();
  } finally {
    if (before === undefined) {
      delete process.env.LIMCOIN_ENCRYPT;
    } else {
      process.env.LIMCOIN_ENCRYPT = before;
    }
  }
};

/* ------------------------------------------- 신원키 */

test("신원키는 데이터 디렉터리에 남고 다시 뜰 때 그대로 쓴다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limcoin-id-"));
  try {
    const first = Transport.loadIdentity(dir);
    assert.match(first, /^[0-9a-f]{64}$/);
    const file = path.join(dir, "node_key");
    assert.ok(fs.existsSync(file));
    // 신원키가 새면 남이 우리 노드를 사칭할 수 있다
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

    assert.strictEqual(Transport.loadIdentity(dir), first, "다시 뜨면 같은 id");

    // 디렉터리가 없으면 메모리에만 둔다 (그때그때 다른 id)
    const ephemeral = Transport.loadIdentity(null);
    assert.match(ephemeral, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(ephemeral, first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- 핸드셰이크 */

test("핸드셰이크가 끝나면 양쪽 다 암호화되고 상대 신원을 안다", () => {
  const { a, b, atA, atB } = pair();
  assert.strictEqual(atA.established, true);
  assert.strictEqual(atB.established, true);
  assert.strictEqual(Transport.isEncrypted(a), true);
  assert.strictEqual(Transport.isEncrypted(b), true);
  // 같은 프로세스라 신원키가 하나뿐이다 — 서로가 본 id 가 우리 id 여야 한다
  assert.strictEqual(Transport.peerIdOf(a), Transport.nodeId());
  assert.strictEqual(Transport.peerIdOf(b), Transport.nodeId());
});

test("핸드셰이크는 망과 서명으로 묶여 있다", () => {
  // 다른 망의 핸드셰이크는 받지 않는다
  const other = socket();
  const hello = Transport.startSession(other, "limcoin/other/9");
  const mine = socket();
  Transport.startSession(mine, NET);
  assert.strictEqual(Transport.unwrap(mine, hello, NET).reject !== undefined, true);

  // 서명을 건드리면 걸린다
  const victim = socket();
  Transport.startSession(victim, NET);
  const source = socket();
  const good = Transport.startSession(source, NET);
  const forged = { ...good, data: { ...good.data, sig: "00".repeat(64) } };
  assert.ok(Transport.unwrap(victim, forged, NET).reject);

  // 남의 임시 키에 내 서명을 붙여 보내는 것도 안 된다 (서명이 임시 키를 덮는다)
  const swapped = { ...good, data: { ...good.data, eph: "aa".repeat(32) } };
  assert.ok(Transport.unwrap(victim, swapped, NET).reject);
});

test("우리 임시 키를 그대로 되돌려 보내면 받지 않는다", () => {
  const me = socket();
  const hello = Transport.startSession(me, NET);
  // 반사: 우리 eph 를 그대로 담아 보낸다 (서명은 맞다 — 우리가 만든 것이므로)
  assert.ok(Transport.unwrap(me, hello, NET).reject);
});

/* ------------------------------------------- 프레임 */

test("핸드셰이크 뒤의 메시지는 암호문으로만 오간다", () => {
  const { a, b } = pair();
  const message = { type: "GET_LATEST", data: { secret: "보이면 안 된다" } };
  const { send } = Transport.wrap(a, message);

  assert.strictEqual(send.type, Transport.ENCRYPTED);
  assert.strictEqual(send.n, 0);
  assert.ok(!JSON.stringify(send).includes("보이면 안 된다"), "평문이 새면 안 된다");
  assert.ok(!JSON.stringify(send).includes("GET_LATEST"));

  assert.deepStrictEqual(Transport.unwrap(b, send, NET).message, message);
});

test("한 글자만 바꿔도 풀리지 않는다 (Poly1305 태그)", () => {
  const { a, b } = pair();
  const frame = Transport.wrap(a, { type: "X", data: [1, 2, 3] }).send;
  const flipped = Buffer.from(frame.c, "hex");
  flipped[0] ^= 0xff;
  const tampered = { ...frame, c: flipped.toString("hex") };
  assert.ok(Transport.unwrap(b, tampered, NET).reject);
});

test("번호가 어긋나면 받지 않는다 (재생·끼워넣기)", () => {
  const { a, b } = pair();
  const first = Transport.wrap(a, { type: "A" }).send;
  const second = Transport.wrap(a, { type: "B" }).send;
  assert.strictEqual(first.n, 0);
  assert.strictEqual(second.n, 1);

  // 순서를 바꿔 보내면 걸린다
  assert.ok(Transport.unwrap(b, second, NET).reject);
  // 제 순서대로면 통과하고
  assert.strictEqual(Transport.unwrap(b, first, NET).message.type, "A");
  // 같은 것을 또 보내면 걸린다
  assert.ok(Transport.unwrap(b, first, NET).reject);
});

test("방향마다 다른 키를 쓴다 — 상대가 보낸 것을 그대로 되돌릴 수 없다", () => {
  const { a, b } = pair();
  const fromA = Transport.wrap(a, { type: "A" }).send;
  // b 가 받은 것을 그대로 a 에게 되돌린다
  assert.strictEqual(Transport.unwrap(b, fromA, NET).message.type, "A");
  assert.ok(Transport.unwrap(a, fromA, NET).reject, "자기 방향 키로는 풀리지 않는다");
});

/* ------------------------------------------- 신원 고정 */

test("주소에 붙인 신원과 다르면 끊는다", () => {
  const id = Transport.nodeId();
  const { url, id: parsed } = Transport.splitPinned(`ws://a.example:3000#${id}`);
  assert.strictEqual(url, "ws://a.example:3000");
  assert.strictEqual(parsed, id);
  assert.deepStrictEqual(Transport.splitPinned("ws://a.example:3000"), {
    url: "ws://a.example:3000",
    id: null
  });
  // id 모양이 아니면 무시한다
  assert.strictEqual(Transport.splitPinned("ws://a.example:3000#짧다").id, null);

  // 맞게 고정하면 붙는다
  const ok = pair(NET, id, id);
  assert.strictEqual(ok.atA.established, true);

  // 다르게 고정하면 fatal 이다 (점수를 매길 일이 아니라 끊을 일)
  const wrong = pair(NET, "ab".repeat(32));
  assert.strictEqual(wrong.atA.fatal, true);
  assert.strictEqual(Transport.isEncrypted(wrong.a), false);
});

/* ------------------------------------------- 모드 */

test("optional 은 암호화를 모르는 상대와도 통한다", () =>
  withMode("optional", () => {
    const me = socket();
    Transport.startSession(me, NET);
    // 상대가 핸드셰이크를 보내기 전에 부친 평문은 받는다
    assert.deepStrictEqual(Transport.unwrap(me, { type: "HELLO" }, NET).message, { type: "HELLO" });

    // 핸드셰이크가 끝나고 상대가 암호문을 보내기 시작한 뒤에는 평문을 받지 않는다
    const { a, b } = pair();
    const frame = Transport.wrap(a, { type: "A" }).send;
    Transport.unwrap(b, frame, NET);
    assert.ok(Transport.unwrap(b, { type: "HELLO" }, NET).reject);
  }));

test("required 는 평문을 아예 받지 않는다", () =>
  withMode("required", () => {
    const me = socket();
    Transport.startSession(me, NET);
    assert.ok(Transport.unwrap(me, { type: "HELLO" }, NET).reject);
    // 핸드셰이크 전에는 보내지 않고 쌓아 둔다
    assert.strictEqual(Transport.wrap(me, { type: "HELLO" }).send, null);
  }));

test("off 면 감싸지 않는다", () =>
  withMode("off", () => {
    const me = socket();
    assert.strictEqual(Transport.startSession(me, NET), null);
    const message = { type: "HELLO" };
    assert.strictEqual(Transport.wrap(me, message).send, message);
    assert.deepStrictEqual(Transport.unwrap(me, message, NET).message, message);
  }));

/* ------------------------------------------- 미뤄 둔 메시지 */

test("핸드셰이크 중에 보낸 것은 끝난 뒤 암호문으로 나간다", () => {
  const a = socket();
  const b = socket();
  const helloA = Transport.startSession(a, NET);
  const helloB = Transport.startSession(b, NET);

  // 아직 상대 핸드셰이크를 못 봤다 — 쌓아 둔다
  assert.strictEqual(Transport.wrap(a, { type: "HELLO" }).send, null);
  assert.strictEqual(Transport.wrap(a, { type: "GET_LATEST" }).send, null);

  Transport.unwrap(a, helloB, NET);
  Transport.unwrap(b, helloA, NET);

  const flushed = Transport.drainQueue(a);
  assert.strictEqual(flushed.length, 2);
  assert.ok(flushed.every(frame => frame.type === Transport.ENCRYPTED));
  assert.strictEqual(Transport.unwrap(b, flushed[0], NET).message.type, "HELLO");
  assert.strictEqual(Transport.unwrap(b, flushed[1], NET).message.type, "GET_LATEST");
  assert.deepStrictEqual(Transport.drainQueue(a), [], "두 번 비우지 않는다");
});

test("서로 다른 연결은 서로 다른 키를 쓴다 (전방 비밀성)", () => {
  const one = pair();
  const two = pair();
  const frame = Transport.wrap(one.a, { type: "A" }).send;
  // 다른 연결의 세션으로는 풀리지 않는다
  assert.ok(Transport.unwrap(two.b, frame, NET).reject);
  assert.notStrictEqual(one.helloA.data.eph, two.helloA.data.eph, "임시 키는 연결마다 새로 만든다");
  void crypto;
});
