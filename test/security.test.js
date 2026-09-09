/**
 * 못된 피어 다루기와 지갑 파일 암호화.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const P2P = require("../src/p2p");
const { getBlockChain } = require("../src/blockchain");

/* ------------------------------------------- 피어 점수 */

// 보낸 것과 닫혔는지를 기억하는 가짜 소켓
const fakeSocket = (url) => {
  const ws = {
    peerUrl: url,
    sent: [],
    closed: false,
    readyState: 1,
    send: data => ws.sent.push(JSON.parse(data)),
    close: () => {
      ws.closed = true;
    },
    on: () => {},
    ping: () => {}
  };
  return ws;
};

test("모양이 어긋난 메시지는 점수가 쌓이고, 문턱을 넘으면 끊고 밴한다", () => {
  P2P.clearBans();
  const ws = fakeSocket("ws://bad.example:3000");

  // 한 번은 봐준다 — 깨진 메시지 하나는 버그일 수도 망 사정일 수도 있다
  for (let i = 0; i < 9; i++) {
    P2P.handleMessage(ws, 12345);
  }
  assert.strictEqual(ws.closed, false, `9번(${9 * P2P.PENALTY.MALFORMED}점)까지는 끊지 않는다`);
  assert.strictEqual(P2P.isBanned("ws://bad.example:3000"), false);

  P2P.handleMessage(ws, 12345); // 100점
  assert.strictEqual(ws.closed, true);
  assert.strictEqual(P2P.isBanned("ws://bad.example:3000"), true);
  assert.deepStrictEqual(
    P2P.getBanned().map(entry => entry.address),
    ["ws://bad.example:3000"]
  );

  assert.strictEqual(P2P.clearBans(), 1);
  assert.strictEqual(P2P.isBanned("ws://bad.example:3000"), false);
});

test("다른 망의 피어는 한 번에 밴한다", () => {
  P2P.clearBans();
  const ws = fakeSocket("ws://other-net.example:3000");
  P2P.handleMessage(ws, { type: "HELLO", data: { network: "limcoin/other/9", url: null } });
  assert.strictEqual(ws.closed, true);
  assert.strictEqual(P2P.isBanned("ws://other-net.example:3000"), true);
  P2P.clearBans();
});

test("같은 망의 HELLO 는 점수가 붙지 않는다", () => {
  P2P.clearBans();
  const ws = fakeSocket("ws://friend.example:3000");
  P2P.handleMessage(ws, { type: "HELLO", data: { network: P2P.NETWORK_MAGIC, url: null } });
  assert.strictEqual(ws.closed, false);
  assert.strictEqual(P2P.isBanned("ws://friend.example:3000"), false);
});

test("달라고 한 적 없는 응답은 그냥 지나친다", () => {
  P2P.clearBans();
  const ws = fakeSocket("ws://noise.example:3000");
  // 동기화를 시작하지 않았으므로 이 응답은 우리 것이 아니다. 벌하지 않는다.
  P2P.handleMessage(ws, {
    type: "HEADERS_RESPONSE",
    data: { headers: [{ index: 1, hash: "가짜" }], height: 1 }
  });
  assert.strictEqual(ws.closed, false);
  assert.strictEqual(P2P.isBanned("ws://noise.example:3000"), false);
});

test("동기화 중에 모양이 어긋난 헤더를 보내면 무겁게 매긴다", () => {
  P2P.clearBans();
  const ws = fakeSocket("ws://liar.example:3000");

  // 우리보다 무겁다고 알려 동기화를 시작하게 만든다 (헤더를 달라고 한다)
  const tip = getBlockChain()[getBlockChain().length - 1];
  const orphan = { ...tip, index: tip.index + 5, hash: "a".repeat(64), previousHash: "b".repeat(64) };
  P2P.handleMessage(ws, {
    type: "BLOCKCHAIN_RESPONSE",
    data: [orphan],
    work: "9".repeat(40)
  });
  assert.ok(ws.sent.some(message => message.type === "GET_HEADERS"), "헤더를 달라고 했다");

  // 이제 보내는 헤더는 우리가 달라고 한 것이다. 모양이 어긋나면 벌한다.
  for (let i = 0; i < 2; i++) {
    P2P.handleMessage(ws, {
      type: "HEADERS_RESPONSE",
      data: { headers: [{ index: 1, hash: "가짜" }], height: 1 }
    });
    if (i === 0) {
      // 접힌 동기화를 다시 열어야 두 번째도 같은 길로 간다
      P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [orphan], work: "9".repeat(40) });
    }
  }
  assert.strictEqual(ws.closed, true, `BAD_BLOCK ${P2P.PENALTY.BAD_BLOCK}점 두 번이면 끊는다`);
  assert.strictEqual(P2P.isBanned("ws://liar.example:3000"), true);
  P2P.clearBans();
});

test("정상 요청에는 점수가 붙지 않는다", () => {
  P2P.clearBans();
  const ws = fakeSocket("ws://good.example:3000");
  for (let i = 0; i < 50; i++) {
    P2P.handleMessage(ws, { type: "GET_LATEST", data: null });
  }
  assert.strictEqual(ws.closed, false);
  assert.strictEqual(ws.sent.length, 50);
  assert.strictEqual(ws.sent[0].data[0].hash, getBlockChain()[getBlockChain().length - 1].hash);
  assert.strictEqual(P2P.isBanned("ws://good.example:3000"), false);
});

/* ------------------------------------------- 지갑 파일 암호화 */

const withWallet = run => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limcoin-wallet-"));
  const before = process.env.LIMCOIN_WALLET_FILE;
  process.env.LIMCOIN_WALLET_FILE = path.join(dir, "wallet.json");
  // 지갑 모듈은 파일 위치를 부를 때마다 읽으므로 캐시만 비우면 된다
  const Wallet = require("../src/wallet");
  Wallet.lock();
  try {
    return run(Wallet, process.env.LIMCOIN_WALLET_FILE);
  } finally {
    if (before === undefined) {
      delete process.env.LIMCOIN_WALLET_FILE;
    } else {
      process.env.LIMCOIN_WALLET_FILE = before;
    }
    Wallet.lock();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("암호를 걸면 파일에 니모닉이 평문으로 남지 않는다", () => {
  withWallet((Wallet, file) => {
    Wallet.initWallet();
    assert.strictEqual(Wallet.isEncrypted(), false);
    const mnemonic = Wallet.getMnemonic();
    const address = Wallet.getReceiveAddress();
    assert.ok(fs.readFileSync(file, "utf8").includes(mnemonic), "걸기 전에는 평문이다");

    Wallet.setPassphrase("open sesame 1234");
    assert.strictEqual(Wallet.isEncrypted(), true);
    const onDisk = fs.readFileSync(file, "utf8");
    assert.ok(!onDisk.includes(mnemonic), "니모닉이 파일에 남으면 안 된다");
    assert.ok(onDisk.includes("aes-256-gcm") && onDisk.includes("scrypt"));

    // 풀어 둔 동안에는 그대로 쓸 수 있다
    assert.strictEqual(Wallet.getReceiveAddress(), address);
    assert.strictEqual(Wallet.isLocked(), false);
  });
});

test("잠긴 지갑은 주소도 내주지 않고, 맞는 암호로만 풀린다", () => {
  withWallet(Wallet => {
    Wallet.initWallet();
    const address = Wallet.getReceiveAddress();
    Wallet.setPassphrase("open sesame 1234");
    Wallet.lock();

    assert.strictEqual(Wallet.isLocked(), true);
    // 주소도 씨앗에서 나오므로 잠긴 동안에는 아무것도 못 한다
    assert.throws(() => Wallet.getReceiveAddress(), /잠겨 있습니다/);
    assert.throws(() => Wallet.getMnemonic(), /잠겨 있습니다/);

    assert.throws(() => Wallet.unlock("틀린 암호"), /암호가 맞지 않습니다/);
    assert.strictEqual(Wallet.isLocked(), true, "틀린 암호로는 풀리지 않는다");

    assert.strictEqual(Wallet.unlock("open sesame 1234"), true);
    assert.strictEqual(Wallet.getReceiveAddress(), address);
  });
});

test("파일을 손대면 복호가 실패한다 (GCM 태그)", () => {
  withWallet((Wallet, file) => {
    Wallet.initWallet();
    Wallet.setPassphrase("open sesame 1234");
    Wallet.lock();

    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const bytes = Buffer.from(stored.crypto.data, "hex");
    bytes[0] ^= 0xff; // 한 바이트만 뒤집는다
    stored.crypto.data = bytes.toString("hex");
    fs.writeFileSync(file, JSON.stringify(stored));

    assert.throws(() => Wallet.unlock("open sesame 1234"), /암호가 맞지 않습니다/);
  });
});

test("암호는 8자 이상이어야 하고, 빈 값을 주면 푼다", () => {
  withWallet((Wallet, file) => {
    Wallet.initWallet();
    const mnemonic = Wallet.getMnemonic();
    assert.throws(() => Wallet.setPassphrase("짧다"), /8자 이상/);

    Wallet.setPassphrase("open sesame 1234");
    assert.strictEqual(Wallet.setPassphrase("").encrypted, false);
    assert.strictEqual(Wallet.isEncrypted(), false);
    assert.ok(fs.readFileSync(file, "utf8").includes(mnemonic), "다시 평문이 된다");
  });
});
