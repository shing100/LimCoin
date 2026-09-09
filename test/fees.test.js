/**
 * 수수료와 mempool 정책 — 바이트 기준.
 *
 * mempool 상한을 작게 줄여 놓고 돌린다(노드 설정과 같은 환경 변수).
 * node:test 는 파일마다 프로세스를 따로 띄우므로 다른 테스트에 새지 않는다.
 */
process.env.LIMCOIN_MAX_MEMPOOL_BYTES = "1300";
process.env.LIMCOIN_MAX_MEMPOOL_TXS = "10";

const test = require("node:test");
const assert = require("node:assert");

const Mempool = require("../src/memPool");
const Transactions = require("../src/transactions");
const { getTxId, getTxSize, getTxFee, MIN_RELAY_FEE_RATE, MAX_BLOCK_BYTES } = Transactions;
const { toHexString } = require("../src/utils");
const { COIN } = require("../src/units");
const { estimateTxSize, txSizeOf } = require("../src/serialization");
const { ecShim: ec, fakeId, newAddress } = require("./helpers");

const makeWallet = () => {
  const keyPair = ec.genKeyPair();
  return { keyPair, address: keyPair.getPublic().encode("hex") };
};

// seed 하나를 써서 send 를 보내고 나머지를 돌려받는다. 남는 차액이 수수료.
const spend = (owner, to, seed, input, send, fee) => {
  const tx = {
    txIns: [{ txOutId: fakeId(seed), txOutIndex: 0, signature: "" }],
    txOuts: [{ address: to, amount: send }]
  };
  const change = input - send - fee;
  if (change > 0) {
    tx.txOuts.push({ address: owner.address, amount: change });
  }
  tx.id = getTxId(tx);
  tx.txIns[0].signature = toHexString(owner.keyPair.sign(tx.id).toDER());
  return tx;
};

const utxo = (owner, seed, amount) => ({
  txOutId: fakeId(seed),
  txOutIndex: 0,
  address: owner.address,
  amount
});

/* ------------------------------------------- 크기 */

test("트랜잭션 크기는 해제 데이터까지 센다", () => {
  const owner = makeWallet();
  const tx = spend(owner, newAddress(), "s", 10 * COIN, 4 * COIN, 10000);
  const size = getTxSize(tx);

  // 서명·공개키를 뺀 것보다 커야 한다 (그것들도 망으로 오가고 디스크에 남는다)
  const bare = { ...tx, txIns: [{ txOutId: tx.txIns[0].txOutId, txOutIndex: 0 }] };
  assert.ok(size > txSizeOf(bare), "해제 데이터도 값을 매긴다");

  /*
   * 지갑은 서명하기 전에 크기를 미리 재서 수수료를 정한다. 미리 잰 값이
   * 실제보다 작으면 수수료가 모자라 안 담긴다 — 넉넉한 쪽으로 잡아야 한다.
   * 주소가 새 형식(Base58, 34자)이면 입력에 공개키(65바이트)도 실린다.
   */
  const modern = { ...tx, txIns: [{ ...tx.txIns[0], publicKey: owner.keyPair.getPublic().encode("hex") }] };
  const realSize = getTxSize(modern);
  const guess = estimateTxSize(1, 2, 130); // 여기 주소는 예전 형식이라 130바이트다
  assert.ok(guess >= realSize, `미리 잰 값(${guess})이 실제(${realSize})보다 작으면 수수료가 모자란다`);
  assert.ok(guess - realSize < 20, `너무 헐겁게 잡아도 안 된다 (${guess} vs ${realSize})`);

  // 출력이 늘면 크기도 는다 — 예전에는 입력 개수만 봐서 둘이 같은 값이었다
  const many = { ...tx, txOuts: [...tx.txOuts, ...tx.txOuts, ...tx.txOuts] };
  many.id = getTxId(many);
  assert.ok(getTxSize(many) > size + 80);
});

/* ------------------------------------------- 최소 수수료율 */

test("수수료율이 최소에 못 미치면 mempool 이 받지 않는다", () => {
  const owner = makeWallet();
  Mempool.updateMempool([]);
  const uTxOuts = [utxo(owner, "s", 10 * COIN)];

  const free = spend(owner, newAddress(), "s", 10 * COIN, 4 * COIN, 0);
  assert.throws(() => Mempool.addToMempool(free, uTxOuts), /수수료가 너무 낮습니다/);

  // 딱 맞는 값이면 들어간다
  const size = getTxSize(free);
  const enough = spend(owner, newAddress(), "s", 10 * COIN, 4 * COIN, size * MIN_RELAY_FEE_RATE + 10);
  Mempool.addToMempool(enough, uTxOuts);
  assert.strictEqual(Mempool.getMempool().length, 1);
  Mempool.updateMempool([]);
});

/* ------------------------------------------- 가득 찼을 때 */

test("mempool 이 가득 차면 수수료율이 낮은 것부터 밀려난다", () => {
  const owner = makeWallet();
  Mempool.updateMempool([]);

  const uTxOuts = [];
  const add = (seed, fee) => {
    uTxOuts.push(utxo(owner, seed, 10 * COIN));
    const tx = spend(owner, newAddress(), seed, 10 * COIN, 1 * COIN, fee);
    Mempool.addToMempool(tx, uTxOuts);
    return tx;
  };

  // 상한이 1300바이트라 400바이트짜리 세 건까지 들어간다
  const cheap = add("a", 2000);
  const mid = add("b", 20000);
  const rich = add("c", 200000);
  assert.strictEqual(Mempool.getMempool().length, 3);
  assert.ok(Mempool.poolBytes() > 1000);

  // 가장 싼 것보다 비싼 것이 들어오면 싼 것이 밀려난다
  uTxOuts.push(utxo(owner, "d", 10 * COIN));
  const newcomer = spend(owner, newAddress(), "d", 10 * COIN, 1 * COIN, 100000);
  Mempool.addToMempool(newcomer, uTxOuts);
  const ids = Mempool.getMempool().map(tx => tx.id);
  assert.ok(!ids.includes(cheap.id), "가장 싼 것이 밀려났다");
  assert.ok(ids.includes(mid.id) && ids.includes(rich.id) && ids.includes(newcomer.id));
  assert.ok(Mempool.poolBytes() <= 1600);

  // 남은 것들보다 싼 것은 아예 들어오지 못한다
  uTxOuts.push(utxo(owner, "e", 10 * COIN));
  const tooCheap = spend(owner, newAddress(), "e", 10 * COIN, 1 * COIN, 2000);
  assert.throws(() => Mempool.addToMempool(tooCheap, uTxOuts), /가득 찼습니다/);
  Mempool.updateMempool([]);
});

/* ------------------------------------------- 묶음(CPFP) */

test("수수료를 적게 낸 부모도 자식이 두둑이 내면 함께 담긴다 (CPFP)", () => {
  const owner = makeWallet();
  const other = makeWallet();
  Mempool.updateMempool([]);

  const uTxOuts = [utxo(owner, "parent", 10 * COIN), utxo(other, "rival", 10 * COIN)];

  // 부모: 수수료를 겨우 낸다
  const parent = spend(owner, owner.address, "parent", 10 * COIN, 5 * COIN, 2000);
  // 자식: 부모의 거스름돈(출력 1)을 쓰면서 두둑이 낸다
  const child = {
    txIns: [{ txOutId: parent.id, txOutIndex: 1, signature: "" }],
    txOuts: [{ address: newAddress(), amount: 1 * COIN }]
  };
  child.id = getTxId(child);
  child.txIns[0].signature = toHexString(owner.keyPair.sign(child.id).toDER());
  // 경쟁자: 부모보다는 비싸고 묶음보다는 싸다
  const rival = spend(other, newAddress(), "rival", 10 * COIN, 1 * COIN, 50000);

  // 한 건만 담을 수 있다면 부모 혼자서는 경쟁자에게 진다
  const one = Mempool.selectTxsForBlock([parent, rival], uTxOuts, { maxTxs: 1, maxBytes: 1e9 });
  assert.deepStrictEqual(one.map(tx => tx.id), [rival.id]);

  // 자식이 함께 있으면 묶음 수수료율이 이겨 부모부터 담긴다
  const picked = Mempool.selectTxsForBlock([parent, child, rival], uTxOuts, {
    maxTxs: 2,
    maxBytes: 1e9
  });
  assert.deepStrictEqual(picked.map(tx => tx.id), [parent.id, child.id], "부모 먼저, 그다음 자식");
});

/* ------------------------------------------- 블록 한도 */

test("블록은 바이트로 찬다", () => {
  const owner = makeWallet();
  const uTxOuts = [];
  const txs = [];
  for (let i = 0; i < 5; i++) {
    uTxOuts.push(utxo(owner, `blk${i}`, 10 * COIN));
    // 수수료를 뚜렷하게 벌려 놓는다 — 서명 길이가 한두 바이트 달라도 순서가 안 뒤집히게
    txs.push(spend(owner, newAddress(), `blk${i}`, 10 * COIN, 1 * COIN, 10000 * (i + 1)));
  }
  const one = getTxSize(txs[0]);

  // 두 건 분량만 주면 두 건만 담긴다 (건수 한도는 넉넉해도)
  const picked = Mempool.selectTxsForBlock(txs, uTxOuts, { maxTxs: 100, maxBytes: one * 2 + 5 });
  assert.strictEqual(picked.length, 2);
  // 수수료가 높은 순이다
  assert.deepStrictEqual(
    picked.map(tx => getTxFee(tx, uTxOuts)),
    [50000, 40000]
  );

  // 한 건도 안 들어가면 빈 블록이다
  assert.deepStrictEqual(Mempool.selectTxsForBlock(txs, uTxOuts, { maxTxs: 100, maxBytes: 10 }), []);
});

test("블록 바이트 한도는 합의 규칙이다", () => {
  assert.strictEqual(MAX_BLOCK_BYTES, 100000);
  const owner = makeWallet();
  const coinbase = Transactions.createCoinbaseTx(newAddress(), 1, 0);

  // 한도를 넘기는 블록은 processTxs 에서 떨어진다.
  // 출력을 잔뜩 붙여 한 건으로 한도를 넘긴다.
  const uTxOuts = [utxo(owner, "big", 10 * COIN)];
  const fat = {
    txIns: [{ txOutId: fakeId("big"), txOutIndex: 0, signature: "" }],
    txOuts: Array.from({ length: 2200 }, () => ({ address: newAddress(), amount: 1000 }))
  };
  fat.id = getTxId(fat);
  fat.txIns[0].signature = toHexString(owner.keyPair.sign(fat.id).toDER());
  assert.ok(getTxSize(fat) > MAX_BLOCK_BYTES, `${getTxSize(fat)} 바이트`);
  assert.strictEqual(Transactions.processTxs([coinbase, fat], uTxOuts, 1, 0), null);
});

/* ------------------------------------------- 권장 수수료 */

test("권장 수수료는 바이트당으로 주고 보통 트랜잭션 값도 함께 준다", () => {
  Mempool.updateMempool([]);
  const quiet = Mempool.estimateFee([], MAX_BLOCK_BYTES);
  assert.strictEqual(quiet.perByte, MIN_RELAY_FEE_RATE);
  assert.strictEqual(quiet.congested, false);
  assert.strictEqual(quiet.typicalTx.fee, quiet.typicalTx.bytes * MIN_RELAY_FEE_RATE);
  assert.strictEqual(quiet.blockBytes, MAX_BLOCK_BYTES);
});
