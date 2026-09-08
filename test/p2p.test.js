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
