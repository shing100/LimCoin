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

test("getMempool 이 준 배열을 밖에서 고쳐도 pool 은 그대로다", () => {
  /*
   * 얕은 복사다. 트랜잭션은 서명이 끝난 뒤로 아무도 고치지 않으므로
   * (고치면 id 가 달라져 검증에서 떨어진다) 지켜야 할 것은 목록 자체다.
   */
  const owner = makeWallet();
  const receiver = makeWallet();
  const uTxOuts = [utxo(owner, "c1", 10 * COIN)];

  Mempool.updateMempool([]);
  Mempool.addToMempool(
    spend(owner, receiver.address, "c1", 10 * COIN, 4 * COIN, 6 * COIN),
    uTxOuts
  );

  const copy = Mempool.getMempool();
  copy.push({ id: "밖에서 끼워 넣은 것" });
  copy.splice(0, 1);
  assert.strictEqual(Mempool.getMempool().length, 1);
  assert.notStrictEqual(Mempool.getMempool()[0].id, "밖에서 끼워 넣은 것");
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

/* ------------------------------------------- 권장 수수료 */

test("다음 블록에 자리가 있으면 바닥값을 권한다", () => {
  Mempool.updateMempool([]);
  const estimate = Mempool.estimateFee([], 99);
  assert.strictEqual(estimate.perInput, Mempool.MIN_FEE_PER_INPUT);
  assert.strictEqual(estimate.congested, false);
  assert.strictEqual(estimate.mempoolSize, 0);
});

test("자리가 꽉 차면 담기는 마지막 자리보다 조금 높은 값을 권한다", () => {
  /*
   * 블록 자리가 3건인데 mempool 에 수수료율 5, 3, 1 이 있다면 3건 모두
   * 담긴다. 여기에 끼어들려면 마지막 자리(1)보다 높아야 한다.
   * 자리가 2건이면 마지막 자리는 3 이다.
   */
  const owner = makeWallet();
  const receiver = makeWallet();
  const uTxOuts = [utxo(owner, "f1", 10 * COIN), utxo(owner, "f2", 10 * COIN), utxo(owner, "f3", 10 * COIN)];
  Mempool.updateMempool([]);
  for (const [id, fee] of [["f1", 50000], ["f2", 30000], ["f3", 10000]]) {
    Mempool.addToMempool(
      spend(owner, receiver.address, id, 10 * COIN, 1 * COIN, 9 * COIN - fee),
      uTxOuts
    );
  }

  const roomy = Mempool.estimateFee(uTxOuts, 99);
  assert.strictEqual(roomy.congested, false, "99자리에 3건이면 널널하다");

  const tight = Mempool.estimateFee(uTxOuts, 2);
  assert.strictEqual(tight.congested, true);
  assert.strictEqual(tight.perInput, 30001, "두 자리째(30000)를 밀어내려면 그보다 1 높아야 한다");
  assert.strictEqual(tight.mempoolSize, 3);
  Mempool.updateMempool([]);
});
