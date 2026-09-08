/**
 * 코인베이스 성숙도.
 *
 * 갓 만들어진 코인베이스 출력은 바로 쓸 수 없다. 체인이 갈라져 그 블록이
 * 밀려나면 코인베이스는 통째로 사라지고, 그것을 쓴 트랜잭션도 전부 무효가
 * 된다 — 그 코인을 받은 사람은 영문도 모르고 잃는다. 일반 트랜잭션은
 * 밀려나도 mempool 로 되돌아가지만 코인베이스는 그럴 수 없다.
 */
const test = require("node:test");
const assert = require("node:assert");
const elliptic = require("elliptic");

const {
  createCoinbaseTx, processTxs, updateUTxOuts, getTxId,
  isSpendable, isCoinbaseTx, COINBASE_MATURITY
} = require("../src/transactions");
const Mempool = require("../src/memPool");
const { toHexString } = require("../src/utils");
const { COIN } = require("../src/units");
const { outpointKey } = require("../src/utxo");

const ec = new elliptic.ec("secp256k1");
const makeWallet = () => {
  const keyPair = ec.genKeyPair();
  return { keyPair, address: keyPair.getPublic().encode("hex") };
};

// 코인베이스 하나뿐인 높이 height 블록을 만들고, 그 뒤의 UTxOut 집합을 준다
const minedAt = (miner, height) => {
  const coinbase = createCoinbaseTx(miner.address, height, 0);
  return { coinbase, uTxOuts: updateUTxOuts([coinbase], [], height) };
};

const spendOutput = (owner, to, source, amount) => {
  const tx = {
    txIns: [{ txOutId: source.txOutId, txOutIndex: source.txOutIndex, signature: "" }],
    txOuts: [{ address: to, amount }]
  };
  tx.id = getTxId(tx);
  tx.txIns[0].signature = toHexString(owner.keyPair.sign(tx.id).toDER());
  return tx;
};

/* ------------------------------------------- 표시가 제대로 붙는가 */

test("코인베이스가 만든 출력에는 생성 높이와 표시가 붙는다", () => {
  const miner = makeWallet();
  const { coinbase, uTxOuts } = minedAt(miner, 7);

  assert.strictEqual(isCoinbaseTx(coinbase), true);
  assert.strictEqual(uTxOuts.length, 1);
  assert.strictEqual(uTxOuts[0].blockIndex, 7);
  assert.strictEqual(uTxOuts[0].coinbase, true);
});

test("일반 트랜잭션이 만든 출력에는 코인베이스 표시가 붙지 않는다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const seed = { txOutId: "seed", txOutIndex: 0, address: alice.address, amount: 10 * COIN };
  const tx = spendOutput(alice, bob.address, seed, 10 * COIN);

  const after = updateUTxOuts([tx], [seed], 3);
  assert.strictEqual(after[0].coinbase, false);
  assert.strictEqual(after[0].blockIndex, 3);
});

/* ------------------------------------------- 성숙도 판정 */

test("코인베이스는 COINBASE_MATURITY 블록이 쌓여야 쓸 수 있다", () => {
  const mined = { coinbase: true, blockIndex: 5 };

  assert.strictEqual(isSpendable(mined, 5), false, "같은 블록에서는 못 쓴다");
  assert.strictEqual(isSpendable(mined, 5 + COINBASE_MATURITY - 1), false);
  assert.strictEqual(isSpendable(mined, 5 + COINBASE_MATURITY), true);
  assert.strictEqual(isSpendable(mined, 5 + COINBASE_MATURITY + 100), true);
});

test("일반 출력은 언제든 쓸 수 있다", () => {
  const ordinary = { coinbase: false, blockIndex: 5 };
  assert.strictEqual(isSpendable(ordinary, 5), true);
  // mempool 이 만든 출력은 블록이 없다
  assert.strictEqual(isSpendable({ coinbase: false, blockIndex: null }, 5), true);
});

test("높이를 모르면 코인베이스는 쓸 수 없는 것으로 본다", () => {
  // 모른 채 통과시키느니 막는다
  const mined = { coinbase: true, blockIndex: 5 };
  assert.strictEqual(isSpendable(mined, undefined), false);
  assert.strictEqual(isSpendable({ coinbase: true, blockIndex: null }, 100), false);
});

/* ------------------------------------------- 블록 검증 */

test("아직 묻히지 않은 코인베이스를 쓰는 블록은 거부된다", () => {
  const miner = makeWallet();
  const receiver = makeWallet();
  const { uTxOuts } = minedAt(miner, 5);
  const source = uTxOuts[0];

  const tooEarly = 5 + COINBASE_MATURITY - 1;
  const spend = spendOutput(miner, receiver.address, source, source.amount);

  assert.strictEqual(
    processTxs([createCoinbaseTx(miner.address, tooEarly, 0), spend], uTxOuts, tooEarly),
    null
  );
});

test("충분히 묻힌 코인베이스는 쓸 수 있다", () => {
  const miner = makeWallet();
  const receiver = makeWallet();
  const { uTxOuts } = minedAt(miner, 5);
  const source = uTxOuts[0];

  const ripe = 5 + COINBASE_MATURITY;
  const spend = spendOutput(miner, receiver.address, source, source.amount);

  const result = processTxs(
    [createCoinbaseTx(miner.address, ripe, 0), spend],
    uTxOuts,
    ripe
  );
  assert.ok(Array.isArray(result), "성숙한 뒤에는 통과해야 한다");
  const keys = result.map(outpointKey);
  assert.ok(!keys.includes(outpointKey(source)), "쓰인 출력은 사라진다");
});

/* ------------------------------------------- mempool */

test("아직 묻히지 않은 코인베이스를 쓰는 트랜잭션은 mempool 에 들어가지 못한다", () => {
  const miner = makeWallet();
  const receiver = makeWallet();
  const { uTxOuts } = minedAt(miner, 5);
  const spend = spendOutput(miner, receiver.address, uTxOuts[0], uTxOuts[0].amount);

  Mempool.updateMempool([]);
  assert.throws(
    () => Mempool.addToMempool(spend, uTxOuts, 5 + COINBASE_MATURITY - 1),
    /invalid/i
  );
  assert.strictEqual(Mempool.getMempool().length, 0);

  // 충분히 쌓인 뒤에는 들어간다
  Mempool.addToMempool(spend, uTxOuts, 5 + COINBASE_MATURITY);
  assert.strictEqual(Mempool.getMempool().length, 1);
  Mempool.updateMempool([]);
});

test("체인이 짧아져 다시 어려진 코인베이스는 블록에 담기지 않는다", () => {
  /*
   * mempool 에 들어올 때는 충분히 묻혀 있었더라도, 체인이 갈라져
   * 짧아지면 다시 어려질 수 있다. 그대로 담으면 스스로 만든 블록이
   * 검증에서 떨어진다. 빼기만 하고 mempool 에는 남겨 둔다.
   */
  const miner = makeWallet();
  const receiver = makeWallet();
  const { uTxOuts } = minedAt(miner, 5);
  const spend = spendOutput(miner, receiver.address, uTxOuts[0], uTxOuts[0].amount);

  Mempool.updateMempool([]);
  Mempool.addToMempool(spend, uTxOuts, 5 + COINBASE_MATURITY);

  const tooEarly = Mempool.selectTxsForBlock(
    Mempool.getMempool(), uTxOuts, 10, 5 + COINBASE_MATURITY - 1
  );
  assert.deepStrictEqual(tooEarly, [], "아직 어리면 담지 않는다");
  assert.strictEqual(Mempool.getMempool().length, 1, "mempool 에는 남아 있어야 한다");

  const ripe = Mempool.selectTxsForBlock(
    Mempool.getMempool(), uTxOuts, 10, 5 + COINBASE_MATURITY
  );
  assert.strictEqual(ripe.length, 1);
  Mempool.updateMempool([]);
});
