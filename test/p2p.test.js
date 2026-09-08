/**
 * 피어가 보낸 메시지 처리.
 *
 * 여기 들어오는 것은 전부 남이 보낸 바이트다. 무엇이 오든 노드가
 * 죽어서는 안 된다.
 */
const test = require("node:test");
const assert = require("node:assert");

const P2P = require("../src/p2p");
const { getBlockChain } = require("../src/blockchain");

// 소켓 대신 보낸 메시지를 모아 두는 가짜
const fakeSocket = () => ({
  readyState: 0, // CLOSED. sendMessage 가 일찍 돌아간다
  sent: []
});

test("망가진 메시지를 받아도 예외를 던지지 않는다", () => {
  /*
   * 예전에는 BLOCKCHAIN_RESPONSE 의 data 가 배열인지 보지 않았다.
   *
   *   {"type":"BLOCKCHAIN_RESPONSE","data":123}
   *
   * 이 한 줄이면 123[NaN] 이 undefined 가 되고 그것의 .index 를 읽다가
   * TypeError 가 났다. ws 의 message 핸들러에서 던진 예외는 아무도 받지
   * 않으므로 프로세스가 그대로 종료된다 — 아무나 P2P 포트에 붙어 한 번
   * 보내면 그 노드는 내려갔다.
   */
  const junk = [
    null,
    undefined,
    123,
    "문자열",
    [1, 2, 3],
    {},
    { type: 42 },
    { type: "BLOCKCHAIN_RESPONSE" },
    { type: "BLOCKCHAIN_RESPONSE", data: null },
    { type: "BLOCKCHAIN_RESPONSE", data: 123 },
    { type: "BLOCKCHAIN_RESPONSE", data: "aaaa" },
    { type: "BLOCKCHAIN_RESPONSE", data: [] },
    { type: "BLOCKCHAIN_RESPONSE", data: [null] },
    { type: "BLOCKCHAIN_RESPONSE", data: [1, 2, 3] },
    { type: "BLOCKCHAIN_RESPONSE", data: [{ index: "높이가 문자열" }] },
    { type: "MEMPOOL_RESPONSE", data: "배열이 아님" },
    { type: "MEMPOOL_RESPONSE", data: [null, 5, {}] },
    { type: "GET_LATEST" },
    { type: "GET_ALL" },
    { type: "REQUEST_MEMPOOL" }
  ];

  const before = getBlockChain().length;
  for (const message of junk) {
    assert.doesNotThrow(
      () => P2P.handleMessage(fakeSocket(), message),
      `이 메시지에서 던졌다: ${JSON.stringify(message)}`
    );
  }
  assert.strictEqual(getBlockChain().length, before, "체인이 그대로여야 한다");
});

test("높이만 앞선 가짜 블록으로 체인이 바뀌지 않는다", () => {
  const before = getBlockChain().length;
  P2P.handleMessage(fakeSocket(), {
    type: "BLOCKCHAIN_RESPONSE",
    data: [
      {
        index: 9999,
        hash: "가짜",
        previousHash: "없음",
        timestamp: Math.round(Date.now() / 1000),
        merkleRoot: "가짜",
        data: [],
        difficulty: 1,
        nonce: 0
      }
    ]
  });
  assert.strictEqual(getBlockChain().length, before);
});

/* ------------------------------------------- 피어 발견 */

const openSocket = () => ({
  readyState: 1,
  sent: [],
  send(text) {
    this.sent.push(JSON.parse(text));
  },
  close() {
    this.readyState = 3;
  }
});

test("HELLO 로 알려 준 주소를 기억하고, 우리 자신의 주소는 배우지 않는다", () => {
  P2P.setPublicUrl("ws://me.example:3000");

  const ws = openSocket();
  P2P.handleMessage(ws, { type: "HELLO", data: { network: P2P.NETWORK_MAGIC, url: "ws://peer-a.example:3000" } });
  assert.strictEqual(ws.advertisedUrl, "ws://peer-a.example:3000");
  assert.ok(P2P.getKnownAddresses().includes("ws://peer-a.example:3000"));

  P2P.handleMessage(openSocket(), { type: "HELLO", data: { network: P2P.NETWORK_MAGIC, url: "ws://me.example:3000" } });
  assert.ok(!P2P.getKnownAddresses().includes("ws://me.example:3000"), "자기 자신은 배우지 않는다");

  // 모양이 이상한 것은 무시한다
  for (const data of [null, 1, {}, { url: 5 }, { network: P2P.NETWORK_MAGIC, url: 5 }, { network: P2P.NETWORK_MAGIC, url: "http://not-ws" }, { network: P2P.NETWORK_MAGIC, url: "ws://" }]) {
    assert.doesNotThrow(() => P2P.handleMessage(openSocket(), { type: "HELLO", data }));
  }
});

test("GET_PEERS 에 아는 주소를 주되, 묻는 쪽 자기 주소는 뺀다", () => {
  const asker = openSocket();
  P2P.handleMessage(asker, { type: "HELLO", data: { network: P2P.NETWORK_MAGIC, url: "ws://asker.example:3000" } });
  P2P.handleMessage(asker, { type: "GET_PEERS" });

  const reply = asker.sent[asker.sent.length - 1];
  assert.strictEqual(reply.type, "PEERS_RESPONSE");
  assert.ok(reply.data.peers.includes("ws://peer-a.example:3000"), "다른 피어는 알려 준다");
  assert.ok(!reply.data.peers.includes("ws://asker.example:3000"), "묻는 쪽 자기 주소는 뺀다");
  assert.ok(!reply.data.peers.includes("ws://me.example:3000"), "우리 주소도 뺀다 (이미 붙어 있으니)");
});

test("PEERS_RESPONSE 로 배운 주소에 outbound 상한까지 알아서 붙는다", () => {
  // 실제로 소켓을 열지만 아무도 듣지 않는 포트라 바로 실패하고, 재연결 타이머는 unref 되어 있다
  const learned = Array.from({ length: P2P.MAX_OUTBOUND + 3 }, (_, i) => `ws://127.0.0.1:${20000 + i}`);
  P2P.handleMessage(openSocket(), { type: "PEERS_RESPONSE", data: { peers: learned } });

  const dialed = P2P.getDialedPeers();
  assert.ok(dialed.length <= P2P.MAX_OUTBOUND, `outbound 는 ${P2P.MAX_OUTBOUND} 개까지 (지금 ${dialed.length})`);
  assert.ok(dialed.length > 0, "배운 주소에 붙기 시작해야 한다");
  for (const url of learned) {
    assert.ok(P2P.getKnownAddresses().includes(url), "붙지 않은 것도 알고는 있다");
  }
  // 정리: 더 이상 다시 걸지 않게
  for (const url of dialed) {
    P2P.disconnectPeer(url);
  }
});

test("망가진 PEERS_RESPONSE / GET_PEERS 에도 죽지 않는다", () => {
  for (const data of [null, 1, {}, { peers: "x" }, { peers: [null, 3, "ws://ok.example:1", "junk"] }]) {
    assert.doesNotThrow(() => P2P.handleMessage(openSocket(), { type: "PEERS_RESPONSE", data }));
  }
  assert.doesNotThrow(() => P2P.handleMessage(openSocket(), { type: "GET_PEERS", data: 42 }));
  for (const url of P2P.getDialedPeers()) {
    P2P.disconnectPeer(url);
  }
});

test("다른 망의 피어는 HELLO 를 보고 끊는다", () => {
  const ws = openSocket();
  let closed = false;
  ws.close = () => { closed = true; };
  P2P.handleMessage(ws, { type: "HELLO", data: { network: "limcoin/other/1", url: "ws://other.example:3000" } });
  assert.strictEqual(closed, true, "테스트넷과 메인넷이 섞이면 안 된다");
  assert.ok(!P2P.getKnownAddresses().includes("ws://other.example:3000"), "다른 망의 주소는 배우지 않는다");
});
