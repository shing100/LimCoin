/**
 * 같은 블록/같은 mempool 안에서 앞선 트랜잭션의 출력을 이어서 쓰는 경우.
 *
 * 확인을 기다리지 않고 연달아 보내는 것(chained send)이 여기 해당한다.
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  getTxId, processTxs, updateUTxOuts, createCoinbaseTx, getBlockSubsidy,
  sumBlockFees
} = require("../src/transactions");
const Mempool = require("../src/memPool");
const { toHexString } = require("../src/utils");
const { COIN, parseLim } = require("../src/units");
const { indexByOutpoint, keyOf } = require("../src/utxo");

const { ecShim: ec, fakeId } = require("./helpers");

const makeWallet = () => {
  const keyPair = ec.genKeyPair();
  return { keyPair, address: keyPair.getPublic().encode("hex") };
};

// outpoint 하나를 써서 to 에게 보내고 남는 것을 owner 가 거슬러 받는다
const spend = (owner, to, txOutId, txOutIndex, send, change) => {
  const tx = {
    txIns: [{ txOutId: fakeId(txOutId), txOutIndex, signature: "" }],
    txOuts: [{ address: to, amount: send }]
  };
  if (change > 0) {
    tx.txOuts.push({ address: owner.address, amount: change });
  }
  tx.id = getTxId(tx);
  tx.txIns[0].signature = toHexString(owner.keyPair.sign(tx.id).toDER());
  return tx;
};

const seedUTxOut = (owner, id, amount) => ({
  txOutId: fakeId(id),
  txOutIndex: 0,
  address: owner.address,
  amount
});

/* ------------------------------------------- updateUTxOuts 순서 */

test("같은 블록에서 만들어지고 바로 쓰인 출력은 남지 않는다", () => {
  /*
   * 새 출력을 붙이기 전에 쓰인 것을 걷어 내면, 그 출력이 spent 검사를
   * 피해 가 UTxOut 집합에 살아남는다. 그러면 이미 쓴 코인을 두 번 쓸 수 있다.
   */
  const alice = makeWallet();
  const bob = makeWallet();
  const before = [seedUTxOut(alice, "seed", 10 * COIN)];

  // t1: alice 의 seed -> alice 자신에게 10
  const t1 = spend(alice, alice.address, "seed", 0, 10 * COIN, 0);
  // t2: t1 이 만든 출력을 바로 써서 bob 에게 10
  const t2 = spend(alice, bob.address, t1.id, 0, 10 * COIN, 0);

  const after = updateUTxOuts([t1, t2], before);
  const index = indexByOutpoint(after);

  assert.strictEqual(index.has(keyOf("seed", 0)), false, "원래 출력은 쓰였다");
  assert.strictEqual(index.has(keyOf(t1.id, 0)), false, "t1 의 출력도 t2 가 썼다");
  assert.strictEqual(index.has(keyOf(t2.id, 0)), true, "t2 의 출력만 남는다");
  assert.strictEqual(after.length, 1);
});

test("총액은 보존된다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const before = [seedUTxOut(alice, "seed", 10 * COIN)];

  const t1 = spend(alice, alice.address, "seed", 0, 10 * COIN, 0);
  const t2 = spend(alice, bob.address, t1.id, 0, 6 * COIN, 4 * COIN);

  const after = updateUTxOuts([t1, t2], before);
  const total = after.reduce((sum, u) => sum + u.amount, 0);
  assert.strictEqual(total, 10 * COIN, "수수료 없이 이어 쓰면 총액이 같아야 한다");
});

/* ------------------------------------------- 블록 검증 */

test("같은 블록 안에서 앞선 트랜잭션의 출력을 쓰는 블록이 통과한다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const miner = makeWallet();
  const uTxOuts = [seedUTxOut(alice, "seed", 10 * COIN)];

  const fee1 = parseLim("0.1");
  const fee2 = parseLim("0.2");
  // t1: seed(10) -> bob 3, alice 거스름돈 6.9  (수수료 0.1)
  const t1 = spend(alice, bob.address, "seed", 0, 3 * COIN, 10 * COIN - 3 * COIN - fee1);
  // t2: t1 의 거스름돈(6.9) -> bob 2, alice 4.7  (수수료 0.2)
  const change1 = 10 * COIN - 3 * COIN - fee1;
  const t2 = spend(alice, bob.address, t1.id, 1, 2 * COIN, change1 - 2 * COIN - fee2);

  const coinbase = createCoinbaseTx(miner.address, 1, fee1 + fee2);
  const result = processTxs([coinbase, t1, t2], uTxOuts, 1);

  assert.ok(Array.isArray(result), "이어 쓰는 블록도 유효해야 한다");
  // 채굴자는 보조금 + 두 수수료를 받는다
  const minerTotal = result
    .filter(u => u.address === miner.address)
    .reduce((sum, u) => sum + u.amount, 0);
  assert.strictEqual(minerTotal, getBlockSubsidy(1) + fee1 + fee2);
});

test("부모 없이 자식만 담긴 블록은 거부된다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const miner = makeWallet();
  const uTxOuts = [seedUTxOut(alice, "seed", 10 * COIN)];

  const t1 = spend(alice, bob.address, "seed", 0, 3 * COIN, 7 * COIN);
  const t2 = spend(alice, bob.address, t1.id, 1, 2 * COIN, 5 * COIN);

  // t1 을 빼고 t2 만 담으면 참조할 출력이 없다
  const coinbase = createCoinbaseTx(miner.address, 1, 0);
  assert.strictEqual(processTxs([coinbase, t2], uTxOuts, 1), null);
});

test("같은 출력을 두 트랜잭션이 쓰는 블록은 거부된다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const miner = makeWallet();
  const uTxOuts = [seedUTxOut(alice, "seed", 10 * COIN)];

  const a = spend(alice, bob.address, "seed", 0, 3 * COIN, 7 * COIN);
  const b = spend(alice, bob.address, "seed", 0, 4 * COIN, 6 * COIN);

  const coinbase = createCoinbaseTx(miner.address, 1, 0);
  assert.strictEqual(processTxs([coinbase, a, b], uTxOuts, 1), null);
});

/* ------------------------------------------- mempool */

test("mempool 이 만든 출력을 이어서 쓸 수 있다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const uTxOuts = [seedUTxOut(alice, "seed", 10 * COIN)];

  Mempool.updateMempool([]);
  const t1 = spend(alice, bob.address, "seed", 0, 3 * COIN, 7 * COIN);
  Mempool.addToMempool(t1, uTxOuts);

  // 확인을 기다리지 않고 거스름돈을 바로 이어서 쓴다
  const t2 = spend(alice, bob.address, t1.id, 1, 2 * COIN, 5 * COIN);
  Mempool.addToMempool(t2, uTxOuts);

  assert.strictEqual(Mempool.getMempool().length, 2);
  Mempool.updateMempool([]);
});

test("이어 쓴 것을 블록에 담을 때 부모가 자식보다 먼저 온다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const uTxOuts = [seedUTxOut(alice, "seed", 10 * COIN)];

  const t1 = spend(alice, bob.address, "seed", 0, 3 * COIN, 7 * COIN);
  const t2 = spend(alice, bob.address, t1.id, 1, 2 * COIN, 5 * COIN);

  // 자식이 수수료율이 높아도 부모가 먼저 담겨야 한다
  const picked = Mempool.selectTxsForBlock([t2, t1], uTxOuts, 10);
  assert.strictEqual(picked.length, 2);
  assert.strictEqual(picked[0].id, t1.id, "부모 먼저");
  assert.strictEqual(picked[1].id, t2.id);
});

test("자리가 모자라면 자식만 담지 않고 갈래째 뺀다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const uTxOuts = [seedUTxOut(alice, "seed", 10 * COIN)];

  const t1 = spend(alice, bob.address, "seed", 0, 3 * COIN, 7 * COIN);
  const t2 = spend(alice, bob.address, t1.id, 1, 2 * COIN, 5 * COIN);

  // 한 자리뿐이면 t1 만 담긴다. t2 만 담으면 그 블록은 검증에서 떨어진다.
  const picked = Mempool.selectTxsForBlock([t2, t1], uTxOuts, 1);
  assert.strictEqual(picked.length, 1);
  assert.strictEqual(picked[0].id, t1.id);
});

test("이어 쓴 트랜잭션들이 실제로 한 블록에 담겨 통과한다", () => {
  const alice = makeWallet();
  const bob = makeWallet();
  const miner = makeWallet();
  const uTxOuts = [seedUTxOut(alice, "seed", 10 * COIN)];

  Mempool.updateMempool([]);
  const fee = parseLim("0.1");
  const t1 = spend(alice, bob.address, "seed", 0, 3 * COIN, 10 * COIN - 3 * COIN - fee);
  Mempool.addToMempool(t1, uTxOuts);
  const change1 = 10 * COIN - 3 * COIN - fee;
  const t2 = spend(alice, bob.address, t1.id, 1, 2 * COIN, change1 - 2 * COIN - fee);
  Mempool.addToMempool(t2, uTxOuts);

  const selected = Mempool.selectTxsForBlock(Mempool.getMempool(), uTxOuts, 10);
  const coinbase = createCoinbaseTx(miner.address, 1, fee * 2);

  assert.ok(
    Array.isArray(processTxs([coinbase, ...selected], uTxOuts, 1)),
    "mempool 에서 골라 담은 그대로 블록이 유효해야 한다"
  );
  Mempool.updateMempool([]);
});

test("이어 쓴 트랜잭션의 수수료도 제대로 세어진다", () => {
  /*
   * 블록 이전의 UTxOut 만 보고 세면, 부모가 mempool 에 있는 자식의 입력이
   * "없는 출력"이 되어 수수료가 크게 음수로 나온다. 그러면 코인베이스가
   * 보조금보다 적게 가져가는 블록을 만들어 스스로 거부하게 된다.
   * 실제로 지갑이 이어 보내기를 하게 되자마자 채굴이 막혔다.
   */
  const alice = makeWallet();
  const bob = makeWallet();
  const miner = makeWallet();
  const uTxOuts = [seedUTxOut(alice, "seed", 10 * COIN)];

  Mempool.updateMempool([]);
  const fee = parseLim("0.1");
  const change1 = 10 * COIN - 3 * COIN - fee;
  const t1 = spend(alice, bob.address, "seed", 0, 3 * COIN, change1);
  Mempool.addToMempool(t1, uTxOuts);
  const t2 = spend(alice, bob.address, t1.id, 1, 2 * COIN, change1 - 2 * COIN - fee);
  Mempool.addToMempool(t2, uTxOuts);

  const selected = Mempool.selectTxsForBlock(Mempool.getMempool(), uTxOuts, 10);
  const totalFees = sumBlockFees(selected, uTxOuts);

  assert.strictEqual(totalFees, fee * 2, "두 건의 수수료가 그대로 더해져야 한다");
  assert.ok(totalFees > 0, "이어 쓴 입력을 못 되짚으면 음수가 된다");

  // 그 합을 그대로 가져가는 코인베이스로 블록이 통과해야 한다
  const coinbase = createCoinbaseTx(miner.address, 1, totalFees);
  assert.ok(
    Array.isArray(processTxs([coinbase, ...selected], uTxOuts, 1)),
    "센 수수료대로 만든 블록이 유효해야 한다"
  );
  Mempool.updateMempool([]);
});

test("이어 쓴 자식도 수수료율 줄 세우기에서 제 값을 받는다", () => {
  // 확정된 UTxOut 만으로 되짚으면 자식의 수수료율이 크게 음수가 되어
  // 언제나 꼴찌가 된다.
  const alice = makeWallet();
  const bob = makeWallet();
  const uTxOuts = [
    seedUTxOut(alice, "seedA", 10 * COIN),
    seedUTxOut(alice, "seedB", 10 * COIN)
  ];

  Mempool.updateMempool([]);
  // 부모: 수수료 0.01, 자식: 수수료 1 (아주 높다)
  const parentFee = parseLim("0.01");
  const childFee = parseLim("1");
  const parentChange = 10 * COIN - 1 * COIN - parentFee;
  const parent = spend(alice, bob.address, "seedA", 0, 1 * COIN, parentChange);
  const child = spend(alice, bob.address, parent.id, 1, 1 * COIN, parentChange - 1 * COIN - childFee);
  // 견줄 상대: 수수료 0.5 짜리 독립 트랜잭션
  const other = spend(alice, bob.address, "seedB", 0, 1 * COIN, 10 * COIN - 1 * COIN - parseLim("0.5"));

  const picked = Mempool.selectTxsForBlock([other, child, parent], uTxOuts, 10);
  assert.strictEqual(picked.length, 3);
  // 자식이 부모를 끌고 올라와야 한다. 부모 없이 자식만 담기면 안 된다.
  assert.ok(
    picked.indexOf(parent) < picked.indexOf(child),
    "부모가 자식보다 먼저"
  );
  assert.strictEqual(
    sumBlockFees(picked, uTxOuts),
    parentFee + childFee + parseLim("0.5")
  );
});

/* ------------------------------------------- 체인 교체 (reorg) */

const { countCommonPrefix, replaceChain } = require("../src/blockchain");
const genesis = require("../src/genesis.json");

test("공통 접두사는 해시가 갈리는 지점까지다", () => {
  const b = (index, hash) => ({ index, hash });
  const ours = [b(0, "g"), b(1, "a"), b(2, "b"), b(3, "c")];

  assert.strictEqual(countCommonPrefix(ours, ours), 4);
  assert.strictEqual(countCommonPrefix(ours, [b(0, "g"), b(1, "a"), b(2, "X")]), 2);
  assert.strictEqual(countCommonPrefix(ours, [b(0, "다름")]), 0);
  assert.strictEqual(countCommonPrefix(ours, []), 0);
  // 짧은 쪽 길이를 넘지 않는다
  assert.strictEqual(countCommonPrefix(ours, [b(0, "g"), b(1, "a")]), 2);
});

test("replaceChain 은 잘못된 체인을 받아도 예외 없이 false 를 돌려준다", () => {
  assert.strictEqual(replaceChain([]), false);
  assert.strictEqual(replaceChain([genesis]), false);
  assert.strictEqual(replaceChain([{ index: 0, hash: "다른 제네시스", data: [] }]), false);
  assert.strictEqual(
    replaceChain([genesis, { index: 1, hash: "가짜", previousHash: "없음", data: [] }]),
    false
  );
});

test("제네시스의 머클 루트가 본문과 어긋나면 거부된다", () => {
  // 해시만 맞추고 본문을 바꿔 치기하는 것을 막는다
  const forged = { ...genesis, data: [] };
  assert.strictEqual(replaceChain([forged]), false);
});
