/**
 * mempool 정책 테스트 — 이중지불 거부, 블록 반영 후 정리, 상한.
 */
const test = require("node:test");
const assert = require("node:assert");
const elliptic = require("elliptic");

const Mempool = require("../src/memPool");
const { getTxId, getTxFee } = require("../src/transactions");
const { toHexString } = require("../src/utils");
const { COIN, parseLim } = require("../src/units");

const ec = new elliptic.ec("secp256k1");

const makeWallet = () => {
  const keyPair = ec.genKeyPair();
  return { keyPair, address: keyPair.getPublic().encode("hex") };
};

// seed 하나를 써서 change 만큼 돌려받는 트랜잭션. 차액이 수수료가 된다.
const spend = (owner, receiver, seed, inputAmount, sendAmount, change) => {
  const tx = {
    txIns: [{ txOutId: seed, txOutIndex: 0, signature: "" }],
    txOuts: [{ address: receiver, amount: sendAmount }]
  };
  if (change > 0) {
    tx.txOuts.push({ address: owner.address, amount: change });
  }
  tx.id = getTxId(tx);
  tx.txIns[0].signature = toHexString(owner.keyPair.sign(tx.id).toDER());
  return tx;
};

const utxo = (owner, seed, amount) => ({
  txOutId: seed,
  txOutIndex: 0,
  address: owner.address,
  amount
});

test("같은 UTxO 를 두 번 쓰려는 트랜잭션은 pool 에 들어가지 못한다", () => {
  const owner = makeWallet();
  const a = makeWallet();
  const b = makeWallet();
  const uTxOuts = [utxo(owner, "seed", 10 * COIN)];

  const first = spend(owner, a.address, "seed", 10 * COIN, 4 * COIN, 6 * COIN);
  const double = spend(owner, b.address, "seed", 10 * COIN, 5 * COIN, 5 * COIN);

  Mempool.updateMempool([]); // 비우기
  Mempool.addToMempool(first, uTxOuts);

  // 두 번째는 같은 seed 를 가리키므로 이중지불이다
  assert.throws(
    () => Mempool.addToMempool(double, uTxOuts),
    /not valid for the pool/
  );
  assert.strictEqual(Mempool.getMempool().length, 1);
  Mempool.updateMempool([]);
});

test("블록에 담겨 UTxO 가 사라지면 pool 에서도 빠진다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();
  const uTxOuts = [utxo(owner, "s1", 10 * COIN), utxo(owner, "s2", 10 * COIN)];

  Mempool.updateMempool([]);
  Mempool.addToMempool(
    spend(owner, receiver.address, "s1", 10 * COIN, 4 * COIN, 6 * COIN),
    uTxOuts
  );
  Mempool.addToMempool(
    spend(owner, receiver.address, "s2", 10 * COIN, 3 * COIN, 7 * COIN),
    uTxOuts
  );
  assert.strictEqual(Mempool.getMempool().length, 2);

  // s1 이 블록에 담겨 없어졌다고 치면 그 트랜잭션만 빠져야 한다
  Mempool.updateMempool([utxo(owner, "s2", 10 * COIN)]);
  const left = Mempool.getMempool();
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].txIns[0].txOutId, "s2");

  Mempool.updateMempool([]);
  assert.strictEqual(Mempool.getMempool().length, 0);
});

test("getMempool 은 복사본을 준다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();
  const uTxOuts = [utxo(owner, "c1", 10 * COIN)];

  Mempool.updateMempool([]);
  Mempool.addToMempool(
    spend(owner, receiver.address, "c1", 10 * COIN, 4 * COIN, 6 * COIN),
    uTxOuts
  );

  const copy = Mempool.getMempool();
  copy[0].txOuts[0].amount = 999;
  // 밖에서 만진 것이 원본에 반영되면 안 된다
  assert.notStrictEqual(Mempool.getMempool()[0].txOuts[0].amount, 999);
  Mempool.updateMempool([]);
});

test("블록에 담을 때 수수료율이 높은 순으로 고르고 한도를 지킨다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();

  const build = (seed, fee) => ({
    tx: spend(owner, receiver.address, seed, 10 * COIN, 5 * COIN, 5 * COIN - fee),
    uTxOut: utxo(owner, seed, 10 * COIN),
    fee
  });

  const low = build("a", parseLim("0.01"));
  const mid = build("b", parseLim("0.5"));
  const high = build("c", parseLim("2"));
  const uTxOuts = [low.uTxOut, mid.uTxOut, high.uTxOut];

  const picked = Mempool.selectTxsForBlock([low.tx, mid.tx, high.tx], uTxOuts, 2);
  assert.deepStrictEqual(
    picked.map(tx => getTxFee(tx, uTxOuts)),
    [high.fee, mid.fee]
  );

  // 한도가 0 이하면 아무것도 담지 않는다 (코인베이스만 있는 블록)
  assert.deepStrictEqual(Mempool.selectTxsForBlock([low.tx], uTxOuts, 0), []);
});

test("pool 이 가득 차면 더 받지 않는다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();

  Mempool.updateMempool([]);
  const uTxOuts = [];
  for (let i = 0; i < Mempool.MAX_MEMPOOL_SIZE; i++) {
    const seed = `full${i}`;
    uTxOuts.push(utxo(owner, seed, 10 * COIN));
  }
  for (let i = 0; i < Mempool.MAX_MEMPOOL_SIZE; i++) {
    Mempool.addToMempool(
      spend(owner, receiver.address, `full${i}`, 10 * COIN, 4 * COIN, 6 * COIN),
      uTxOuts
    );
  }
  assert.strictEqual(Mempool.getMempool().length, Mempool.MAX_MEMPOOL_SIZE);

  const extraUtxo = utxo(owner, "overflow", 10 * COIN);
  assert.throws(
    () =>
      Mempool.addToMempool(
        spend(owner, receiver.address, "overflow", 10 * COIN, 4 * COIN, 6 * COIN),
        [...uTxOuts, extraUtxo]
      ),
    /mempool is full/
  );
  Mempool.updateMempool([]);
});
