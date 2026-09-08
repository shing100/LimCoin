/**
 * 체인 동기화 프로토콜 (GET_BLOCKS / BLOCKS_RESPONSE).
 *
 * 예전에는 뒤처진 노드가 GET_ALL 을 보내면 상대가 체인 전체를 한 메시지에
 * 담아 보냈다. 메시지 상한(8MB)을 넘는 순간 새 노드는 동기화 자체를 못 했다.
 */
const test = require("node:test");
const assert = require("node:assert");

const P2P = require("../src/p2p");
const Blockchain = require("../src/blockchain");
const { mineChainOnto, coinbaseBlockOnto } = require("./helpers");

const { getBlockChain, getNewestBlock, addBlockToChain } = Blockchain;
const HEADER_WINDOW = P2P.HEADER_WINDOW;
const genesis = getBlockChain()[0];

// 보낸 메시지를 모아 두는 가짜 소켓. readyState 1 = OPEN
const fakeSocket = () => ({
  readyState: 1,
  sent: [],
  send(text) {
    this.sent.push(JSON.parse(text));
  }
});

const lastSent = ws => ws.sent[ws.sent.length - 1];

/* ------------------------------------------- locator */

test("locator 는 끝에서 열 개는 촘촘히, 그 뒤는 간격을 두 배씩 늘려 제네시스까지 담는다", () => {
  const hashes = P2P.buildLocator({ buffer: [] });
  const chain = getBlockChain();
  const tip = chain.length - 1;

  assert.strictEqual(hashes[0], chain[tip].hash, "맨 앞은 우리 끝");
  assert.strictEqual(hashes[hashes.length - 1], chain[0].hash, "마지막은 제네시스");
  // 전부 우리 체인에 있는 해시여야 한다
  const known = new Set(chain.map(b => b.hash));
  assert.ok(hashes.every(h => known.has(h)));
  // 체인 길이보다 훨씬 적은 개수로 덮는다 (O(log n))
  assert.ok(hashes.length <= Math.min(chain.length, 10 + Math.ceil(Math.log2(chain.length + 1)) + 1));
});

test("갈라진 체인을 받는 중이면 locator 맨 앞은 지금까지 받은 마지막 해시다", () => {
  const hashes = P2P.buildLocator({ buffer: [{ hash: "받은것" }] });
  assert.strictEqual(hashes[0], "받은것");
});

/* ------------------------------------------- 서버 쪽: GET_BLOCKS 응답 */

test("GET_BLOCKS 는 locator 중 우리가 아는 첫 해시 다음부터 준다", () => {
  // 우리 체인을 몇 블록 키운다
  const added = mineChainOnto(getNewestBlock(), 3, 1);
  for (const block of added) {
    assert.strictEqual(addBlockToChain(block), true);
  }
  const chain = getBlockChain();
  const tip = chain.length - 1;

  // 상대가 제네시스만 안다
  let ws = fakeSocket();
  P2P.handleMessage(ws, { type: "GET_BLOCKS", data: { locator: [genesis.hash] } });
  let reply = lastSent(ws);
  assert.strictEqual(reply.type, "BLOCKS_RESPONSE");
  assert.strictEqual(reply.data.height, tip);
  assert.deepStrictEqual(reply.data.blocks.map(b => b.index), chain.slice(1).map(b => b.index));

  // 상대가 끝에서 두 번째까지 안다 (모르는 해시가 앞에 섞여 있어도 아는 첫 것을 쓴다)
  ws = fakeSocket();
  P2P.handleMessage(ws, {
    type: "GET_BLOCKS",
    data: { locator: ["모르는해시", chain[tip - 1].hash, genesis.hash] }
  });
  reply = lastSent(ws);
  assert.deepStrictEqual(reply.data.blocks.map(b => b.index), [tip]);

  // 이미 끝까지 안다 → 빈 묶음
  ws = fakeSocket();
  P2P.handleMessage(ws, { type: "GET_BLOCKS", data: { locator: [chain[tip].hash] } });
  assert.deepStrictEqual(lastSent(ws).data.blocks, []);
});

test("아는 해시가 하나도 없으면 제네시스부터 준다", () => {
  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "GET_BLOCKS", data: { locator: ["a", "b"] } });
  assert.strictEqual(lastSent(ws).data.blocks[0].index, 0);
});

test("망가진 GET_BLOCKS 에도 죽지 않는다", () => {
  for (const data of [null, 1, "x", {}, { locator: 5 }, { locator: [null, 3, {}] }]) {
    assert.doesNotThrow(() => P2P.handleMessage(fakeSocket(), { type: "GET_BLOCKS", data }));
  }
});

/* ------------------------------------------- 클라이언트 쪽: 뒤처졌을 때 */

test("이어지지 않는 소식은 먼저 헤더를 달라고 한다 (블록이 아니라)", () => {
  const tip = getNewestBlock();
  // 우리보다 두 블록 앞선 어떤 블록 (previousHash 가 우리 것이 아님)
  const farAhead = { ...coinbaseBlockOnto(tip, undefined, 50), index: tip.index + 2, previousHash: "모름" };

  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [farAhead] });

  const request = lastSent(ws);
  assert.strictEqual(request.type, "GET_HEADERS", "예전에는 GET_ALL 을 모두에게, 그다음엔 GET_BLOCKS 를 보냈다");
  assert.ok(Array.isArray(request.data.locator));
  assert.strictEqual(request.data.locator[0], tip.hash, "우리 끝 해시가 맨 앞");
  // 같은 피어에게 두 번 겹쳐 요청하지 않는다
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [farAhead] });
  assert.strictEqual(ws.sent.filter(m => m.type === "GET_HEADERS").length, 1);
});

test("더 짧아도 더 무겁다고 하면 헤더를 달라고 한다", () => {
  /*
   * 예전에는 높이로만 판단해서, 더 짧지만 난이도가 높은 체인은 소식을
   * 들어도 받지 않았다. 체인을 고르는 기준은 높이가 아니라 무게다.
   */
  const chain = getBlockChain();
  const ours = Blockchain.chainWork(chain);
  const shorter = { ...chain[Math.max(1, chain.length - 2)], hash: "다른체인의끝", previousHash: "모름" };

  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [shorter], work: ours + 1 });
  assert.strictEqual(lastSent(ws).type, "GET_HEADERS");

  // 무겁지 않다고 하면 (그리고 높이도 낮으면) 아무것도 하지 않는다
  const ws2 = fakeSocket();
  P2P.handleMessage(ws2, { type: "BLOCKCHAIN_RESPONSE", data: [shorter], work: ours - 1 });
  assert.strictEqual(ws2.sent.length, 0);
});

/* ------------------------------------------- 헤더 단계 */

test("GET_HEADERS 는 본문 없는 헤더를 준다", () => {
  const chain = getBlockChain();
  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "GET_HEADERS", data: { locator: [genesis.hash] } });
  const reply = lastSent(ws);

  assert.strictEqual(reply.type, "HEADERS_RESPONSE");
  assert.strictEqual(reply.data.height, chain.length - 1);
  assert.strictEqual(reply.data.headers.length, chain.length - 1);
  for (const header of reply.data.headers) {
    assert.strictEqual(header.data, undefined, "본문은 없어야 한다");
    assert.strictEqual(typeof header.hash, "string");
    assert.strictEqual(typeof header.nonce, "number");
  }
});

test("헤더를 다 받아 더 무거우면 그 블록들을 달라고 한다", () => {
  const tip = getNewestBlock();
  const theirs = mineChainOnto(tip, 2, 100);
  const headers = theirs.map(Blockchain.headerOf);

  const ws = fakeSocket();
  // 소식 → GET_HEADERS
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [theirs[1]], work: Blockchain.chainWork(getBlockChain()) + 100 });
  assert.strictEqual(lastSent(ws).type, "GET_HEADERS");

  // 헤더 응답 → 무게 비교 → GET_BLOCKS (갈라진 지점 = 우리 끝 다음부터)
  P2P.handleMessage(ws, { type: "HEADERS_RESPONSE", data: { headers, height: theirs[1].index } });
  const request = lastSent(ws);
  assert.strictEqual(request.type, "GET_BLOCKS");
  assert.strictEqual(request.data.locator[0], tip.hash);
  assert.strictEqual(getNewestBlock().hash, tip.hash, "블록을 받기 전이라 체인은 그대로");

  // 블록 응답 → 붙는다
  P2P.handleMessage(ws, { type: "BLOCKS_RESPONSE", data: { blocks: theirs, height: theirs[1].index } });
  assert.strictEqual(getNewestBlock().hash, theirs[1].hash);
});

test("헤더 체인이 우리보다 무겁지 않으면 블록을 받지 않는다", () => {
  const chain = getBlockChain();
  const fork = chain[chain.length - 2];
  // 우리 끝과 같은 높이의 다른 블록 하나 — 무게가 같다
  const rival = coinbaseBlockOnto(fork, undefined, 110);

  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [rival], work: Blockchain.chainWork(chain) + 1 });
  assert.strictEqual(lastSent(ws).type, "GET_HEADERS", "말로는 무겁다고 했으니 헤더는 받아 본다");
  P2P.handleMessage(ws, { type: "HEADERS_RESPONSE", data: { headers: [Blockchain.headerOf(rival)], height: rival.index } });

  assert.strictEqual(ws.sent.filter(m => m.type === "GET_BLOCKS").length, 0, "직접 재 보니 무겁지 않다");
  assert.strictEqual(getNewestBlock().hash, chain[chain.length - 1].hash);
});

test("작업증명이 틀린 헤더는 받자마자 버린다", () => {
  const tip = getNewestBlock();
  const good = coinbaseBlockOnto(tip, undefined, 120);
  const forged = { ...Blockchain.headerOf(good), nonce: good.nonce + 1 }; // 해시가 안 맞는다

  // 소식은 우리 끝에 바로 이어지지 않는 것이어야 헤더 단계로 간다
  const news = { ...good, index: good.index + 1, previousHash: "모름" };

  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [news], work: 1e18 });
  assert.strictEqual(lastSent(ws).type, "GET_HEADERS");
  P2P.handleMessage(ws, { type: "HEADERS_RESPONSE", data: { headers: [forged], height: good.index } });

  assert.strictEqual(ws.sent.filter(m => m.type === "GET_BLOCKS").length, 0);
  assert.strictEqual(getNewestBlock().hash, tip.hash);
  // 동기화 상태가 초기화되어 다음 소식에 다시 헤더를 달라고 할 수 있다
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [news], work: 1e18 });
  assert.strictEqual(ws.sent.filter(m => m.type === "GET_HEADERS").length, 2);
});

test("헤더에서 보지 못한 블록이 오면 버린다", () => {
  const tip = getNewestBlock();
  const announced = mineChainOnto(tip, 2, 130);
  const other = mineChainOnto(tip, 2, 140); // 같은 높이의 다른 블록들

  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [announced[1]], work: 1e18 });
  P2P.handleMessage(ws, {
    type: "HEADERS_RESPONSE",
    data: { headers: announced.map(Blockchain.headerOf), height: announced[1].index }
  });
  assert.strictEqual(lastSent(ws).type, "GET_BLOCKS");

  P2P.handleMessage(ws, { type: "BLOCKS_RESPONSE", data: { blocks: other, height: other[1].index } });
  assert.strictEqual(getNewestBlock().hash, tip.hash, "헤더와 다른 블록은 붙이지 않는다");
});

test("우리 끝에 이어지는 묶음은 하나씩 바로 붙이고, 끝까지 받았으면 알린다", () => {
  const before = getNewestBlock();
  const batch = mineChainOnto(before, 3, 10);

  const ws = fakeSocket();
  P2P.handleMessage(ws, {
    type: "BLOCKS_RESPONSE",
    data: { blocks: batch, height: batch[batch.length - 1].index }
  });

  assert.strictEqual(getNewestBlock().hash, batch[2].hash, "세 블록이 붙어야 한다");
  // 끝까지 받았으므로 더 달라고 하지 않는다
  assert.strictEqual(ws.sent.filter(m => m.type === "GET_BLOCKS").length, 0);
});

test("상대 높이에 못 미치면 다음 묶음을 달라고 한다", () => {
  const before = getNewestBlock();
  const batch = mineChainOnto(before, 2, 20);

  const ws = fakeSocket();
  P2P.handleMessage(ws, {
    type: "BLOCKS_RESPONSE",
    data: { blocks: batch, height: batch[1].index + 5 } // 상대는 다섯 블록 더 있다
  });

  assert.strictEqual(getNewestBlock().hash, batch[1].hash);
  const next = lastSent(ws);
  assert.strictEqual(next.type, "GET_BLOCKS");
  assert.strictEqual(next.data.locator[0], batch[1].hash, "새 끝에서 이어 달라고 한다");
});

test("우리 체인 어디에도 붙지 않는 묶음은 버린다", () => {
  const before = getNewestBlock();
  const stray = mineChainOnto({ ...before, hash: "f".repeat(64), index: before.index }, 2, 30);

  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKS_RESPONSE", data: { blocks: stray, height: 999 } });

  assert.strictEqual(getNewestBlock().hash, before.hash, "체인이 그대로여야 한다");
});

test("묶음 안에서 서로 이어지지 않으면 버린다", () => {
  const before = getNewestBlock();
  const a = coinbaseBlockOnto(before, undefined, 40);
  const b = coinbaseBlockOnto(before, undefined, 41); // a 가 아니라 before 위에

  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKS_RESPONSE", data: { blocks: [a, b], height: 999 } });
  assert.strictEqual(getNewestBlock().hash, before.hash);
});

test("갈라진 체인은 다 받은 뒤 한 번에 갈아 끼운다", () => {
  /*
   * 조각마다 갈아 끼우려 하면 아직 무게가 모자라 거부된다. 우리가 A1 A2 를
   * 가진 채 상대가 B1 B2 B3 을 두 묶음(B1 B2 / B3)으로 준다면, 첫 묶음만
   * 으로는 무게가 같아서 바뀌지 않는다. 쌓아 두고 끝에서 한 번에 판단한다.
   */
  const fork = getNewestBlock();
  const ours = mineChainOnto(fork, 2, 60);
  for (const block of ours) {
    assert.strictEqual(addBlockToChain(block), true);
  }
  const theirs = mineChainOnto(fork, 3, 70);

  const ws = fakeSocket();
  // 첫 묶음: B1 B2. 상대 높이는 B3 까지.
  P2P.handleMessage(ws, {
    type: "BLOCKS_RESPONSE",
    data: { blocks: theirs.slice(0, 2), height: theirs[2].index }
  });
  assert.strictEqual(getNewestBlock().hash, ours[1].hash, "아직은 우리 체인 그대로");
  const next = lastSent(ws);
  assert.strictEqual(next.type, "GET_BLOCKS");
  assert.strictEqual(next.data.locator[0], theirs[1].hash, "받은 곳에서 이어 달라고 한다");

  // 둘째 묶음: B3. 이제 무게가 더 크다.
  P2P.handleMessage(ws, {
    type: "BLOCKS_RESPONSE",
    data: { blocks: [theirs[2]], height: theirs[2].index }
  });
  assert.strictEqual(getNewestBlock().hash, theirs[2].hash, "갈아 끼워야 한다");
  assert.strictEqual(getBlockChain().length, fork.index + 4);
});

test("빈 묶음이 오면 동기화를 마친다", () => {
  const before = getNewestBlock();
  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKS_RESPONSE", data: { blocks: [], height: before.index } });
  assert.strictEqual(getNewestBlock().hash, before.hash);
  assert.strictEqual(ws.sent.length, 0);
});

test("창보다 긴 헤더 묶음도 끝까지 검증하고 받는다 (난이도 조정 지점을 지나며)", () => {
  /*
   * 헤더 단계는 마지막 HEADER_WINDOW 개만 들고 있다. 난이도 계산은 직전
   * 10개, MTP 는 직전 11개를 보므로 그만큼이면 되는데, 창이 밀려나는
   * 경계에서 틀어지면 여기서 걸린다. 난이도 조정 높이(10의 배수)를
   * 적어도 하나 지나가게 한다.
   */
  const tip = getNewestBlock();
  const count = HEADER_WINDOW + 3;
  const theirs = mineChainOnto(tip, count, 300);
  const headers = theirs.map(Blockchain.headerOf);

  const ws = fakeSocket();
  P2P.handleMessage(ws, { type: "BLOCKCHAIN_RESPONSE", data: [theirs[count - 1]], work: 1e18 });
  assert.strictEqual(lastSent(ws).type, "GET_HEADERS");

  // 두 묶음으로 나눠 준다
  const half = Math.floor(count / 2);
  P2P.handleMessage(ws, { type: "HEADERS_RESPONSE", data: { headers: headers.slice(0, half), height: theirs[count - 1].index } });
  assert.strictEqual(lastSent(ws).type, "GET_HEADERS", "아직 상대 높이에 못 미쳤다");
  assert.strictEqual(lastSent(ws).data.locator[0], headers[half - 1].hash, "받은 마지막 헤더 다음부터");

  P2P.handleMessage(ws, { type: "HEADERS_RESPONSE", data: { headers: headers.slice(half), height: theirs[count - 1].index } });
  assert.strictEqual(lastSent(ws).type, "GET_BLOCKS", "다 받아 무게가 더 크니 블록을 달라고 한다");

  P2P.handleMessage(ws, { type: "BLOCKS_RESPONSE", data: { blocks: theirs, height: theirs[count - 1].index } });
  assert.strictEqual(getNewestBlock().hash, theirs[count - 1].hash);
});
