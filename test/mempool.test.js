/**
 * mempool 정책 테스트 — 이중지불 거부, 블록 반영 후 정리, 상한.
 */
const test = require("node:test");
const assert = require("node:assert");

const Mempool = require("../src/memPool");
const { getTxId, getTxFee, getTxSize, MIN_RELAY_FEE_RATE } = require("../src/transactions");
const { toHexString } = require("../src/utils");
const { COIN, parseLim } = require("../src/units");

const { ecShim: ec, fakeId } = require("./helpers");

/*
 * 최소 릴레이 수수료를 넘기는 값. 여기 트랜잭션은 400바이트 안쪽이고
 * 최소 수수료율이 4 lm/byte 이므로 넉넉히 잡는다.
 */
const FEE = 10000;

const makeWallet = () => {
  const keyPair = ec.genKeyPair();
  return { keyPair, address: keyPair.getPublic().encode("hex") };
};

// seed 하나를 써서 change 만큼 돌려받는 트랜잭션. 차액이 수수료가 된다.
const spend = (owner, receiver, seed, inputAmount, sendAmount, change) => {
  const tx = {
    txIns: [{ txOutId: fakeId(seed), txOutIndex: 0, signature: "" }],
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
  txOutId: fakeId(seed),
  txOutIndex: 0,
  address: owner.address,
  amount
});

test("같은 UTxO 를 두 번 쓰려는 트랜잭션은 수수료를 충분히 얹어야 앞의 것을 밀어낸다", () => {
  /*
   * 이중지불은 그냥 거절하는 것이 아니라 바꿔치기(RBF)로 다룬다. 수수료를
   * 적게 매겨 묶인 트랜잭션을 푸는 길이 그것뿐이기 때문이다. 대신 값을
   * 치러야 한다 — 밀려나는 것의 수수료보다 많이, 그리고 자기 대역폭 값까지.
   */
  const owner = makeWallet();
  const a = makeWallet();
  const b = makeWallet();
  const uTxOuts = [utxo(owner, "seed", 10 * COIN)];

  const first = spend(owner, a.address, "seed", 10 * COIN, 4 * COIN, 6 * COIN - FEE);
  Mempool.updateMempool([]);
  Mempool.addToMempool(first, uTxOuts);

  // 더 싼 것으로는 밀어낼 수 없다
  const cheaper = spend(owner, b.address, "seed", 10 * COIN, 5 * COIN, 5 * COIN - FEE / 2);
  assert.throws(() => Mempool.addToMempool(cheaper, uTxOuts), /수수료율이 더 높아야/);
  assert.deepStrictEqual(Mempool.getMempool().map(tx => tx.id), [first.id]);

  // 조금 더 내는 것으로도 안 된다 — 밀려나는 수수료 + 자기 대역폭 값을 넘어야 한다
  const barely = spend(owner, b.address, "seed", 10 * COIN, 5 * COIN, 5 * COIN - FEE - 100);
  assert.throws(() => Mempool.addToMempool(barely, uTxOuts), /수수료가 .* 이상이어야/);
  assert.deepStrictEqual(Mempool.getMempool().map(tx => tx.id), [first.id]);

  // 넉넉히 얹으면 앞의 것이 밀려나고 새 것이 남는다
  const better = spend(owner, b.address, "seed", 10 * COIN, 5 * COIN, 5 * COIN - 3 * FEE);
  Mempool.addToMempool(better, uTxOuts);
  assert.deepStrictEqual(Mempool.getMempool().map(tx => tx.id), [better.id]);
  Mempool.updateMempool([]);
});

test("블록에 담겨 UTxO 가 사라지면 pool 에서도 빠진다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();
  const uTxOuts = [utxo(owner, "s1", 10 * COIN), utxo(owner, "s2", 10 * COIN)];

  Mempool.updateMempool([]);
  Mempool.addToMempool(
    spend(owner, receiver.address, "s1", 10 * COIN, 4 * COIN, 6 * COIN - FEE),
    uTxOuts
  );
  Mempool.addToMempool(
    spend(owner, receiver.address, "s2", 10 * COIN, 3 * COIN, 7 * COIN - FEE),
    uTxOuts
  );
  assert.strictEqual(Mempool.getMempool().length, 2);

  // s1 이 블록에 담겨 없어졌다고 치면 그 트랜잭션만 빠져야 한다
  Mempool.updateMempool([utxo(owner, "s2", 10 * COIN)]);
  const left = Mempool.getMempool();
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].txIns[0].txOutId, fakeId("s2"));

  Mempool.updateMempool([]);
  assert.strictEqual(Mempool.getMempool().length, 0);
});

test("부모가 pool 에 있는 자식(이어 쓰기)은 상관없는 블록이 붙어도 남는다", () => {
  const owner = makeWallet();
  const a = makeWallet();
  const b = makeWallet();
  const uTxOuts = [utxo(owner, "seed", 10 * COIN)];

  // 부모: seed(10) -> a 4, owner 5 (수수료 1)
  const parent = spend(owner, a.address, "seed", 10 * COIN, 4 * COIN, 5 * COIN);
  // 자식: 부모의 잔돈 출력(index 1, 5) -> b 2, owner 2 (수수료 1)
  const child = {
    txIns: [{ txOutId: parent.id, txOutIndex: 1, signature: "" }],
    txOuts: [
      { address: b.address, amount: 2 * COIN },
      { address: owner.address, amount: 2 * COIN }
    ]
  };
  child.id = getTxId(child);
  child.txIns[0].signature = toHexString(owner.keyPair.sign(child.id).toDER());

  Mempool.updateMempool([]);
  Mempool.addToMempool(parent, uTxOuts);
  Mempool.addToMempool(child, uTxOuts);
  assert.deepStrictEqual(Mempool.getMempool().map(tx => tx.id), [parent.id, child.id]);

  // 둘과 무관한 블록이 붙었다: seed 는 그대로, 다른 UTxO 하나가 늘었다.
  // 수정 전에는 확정 출력만 보고 자식을 버렸다.
  Mempool.updateMempool([...uTxOuts, utxo(owner, "other", COIN)]);
  assert.deepStrictEqual(Mempool.getMempool().map(tx => tx.id), [parent.id, child.id]);

  // 부모가 블록에 담겼다: seed 가 사라지고 부모의 출력이 확정됐다 -> 자식만 남는다
  Mempool.updateMempool([
    { txOutId: parent.id, txOutIndex: 0, address: a.address, amount: 4 * COIN },
    { txOutId: parent.id, txOutIndex: 1, address: owner.address, amount: 5 * COIN }
  ]);
  assert.deepStrictEqual(Mempool.getMempool().map(tx => tx.id), [child.id]);

  // seed 가 다른 트랜잭션으로 쓰였다(부모 출력 없음) -> 자식도 함께 빠진다
  Mempool.updateMempool([]);
  Mempool.addToMempool(parent, uTxOuts);
  Mempool.addToMempool(child, uTxOuts);
  Mempool.updateMempool([utxo(owner, "other", COIN)]);
  assert.deepStrictEqual(Mempool.getMempool(), []);
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
    spend(owner, receiver.address, "c1", 10 * COIN, 4 * COIN, 6 * COIN - FEE),
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

/* ------------------------------------------- 권장 수수료 */

test("다음 블록에 자리가 있으면 바닥값을 권한다", () => {
  Mempool.updateMempool([]);
  const estimate = Mempool.estimateFee([], 100000);
  assert.strictEqual(estimate.perByte, MIN_RELAY_FEE_RATE);
  assert.strictEqual(estimate.congested, false);
  assert.strictEqual(estimate.mempoolSize, 0);
  assert.strictEqual(estimate.mempoolBytes, 0);
  // 지갑이 바로 쓸 수 있게 보통 트랜잭션 값도 함께 준다
  assert.ok(estimate.typicalTx.bytes > 200 && estimate.typicalTx.bytes < 400);
  assert.strictEqual(estimate.typicalTx.fee, MIN_RELAY_FEE_RATE * estimate.typicalTx.bytes);
});

test("자리가 꽉 차면 담기는 마지막 자리보다 조금 높은 값을 권한다", () => {
  /*
   * 블록이 바이트로 차므로, 수수료율 높은 순으로 세워 놓고 한 블록 분량을
   * 채운 뒤 잘리는 자리의 값을 본다. 여기 트랜잭션은 400바이트 안쪽이라
   * 블록을 두 건 분량(800바이트)으로 잡으면 세 번째가 잘린다.
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

  const roomy = Mempool.estimateFee(uTxOuts, 100000);
  assert.strictEqual(roomy.congested, false, "100KB 에 3건이면 널널하다");
  assert.strictEqual(roomy.perByte, MIN_RELAY_FEE_RATE);

  const sizes = Mempool.getMempool().map(tx => getTxSize(tx));
  const tight = Mempool.estimateFee(uTxOuts, sizes[0] + sizes[1]);
  assert.strictEqual(tight.congested, true);
  // 두 건이 차면 잘리는 자리는 두 번째(30000 lm)다. 그보다 높아야 끼어든다.
  const secondRate = 30000 / sizes[1];
  assert.strictEqual(tight.perByte, Math.floor(secondRate) + 1);
  assert.ok(tight.perByte > secondRate);
  assert.strictEqual(tight.mempoolSize, 3);
  assert.strictEqual(tight.mempoolBytes, sizes.reduce((a, b) => a + b, 0));
  Mempool.updateMempool([]);
});
