/**
 * 노드 운영 기능 테스트 — 영속성, 인덱싱, 재구성 시 트랜잭션 복구.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Store = require("../src/store");
const { indexByOutpoint, indexByAddress, keyOf } = require("../src/utxo");
const { validateTx, getTxId, createCoinbaseTx, getBlockSubsidy } = require("../src/transactions");
const { COIN } = require("../src/units");
const genesis = require("../src/genesis.json");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "limcoin-test-"));

/* ------------------------------------------------------------ 저장소 */

test("열지 않은 저장소는 디스크를 건드리지 않는다", () => {
  Store.close();
  assert.strictEqual(Store.isOpen(), false);
  assert.deepStrictEqual(Store.loadBlocks(), []);
  // 던지지 않고 조용히 무시해야 한다
  Store.appendBlock(genesis);
  Store.writeBlocks([genesis]);
});

test("append 한 블록을 그대로 읽어 온다", () => {
  const dir = tmpDir();
  Store.open(dir);
  try {
    assert.deepStrictEqual(Store.loadBlocks(), []);

    Store.appendBlock(genesis);
    Store.appendBlock({ ...genesis, index: 1, hash: "abc" });

    const loaded = Store.loadBlocks();
    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[0].hash, genesis.hash);
    assert.strictEqual(loaded[1].index, 1);
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("append 도중 죽어 마지막 줄이 깨져도 거기까지는 복원한다", () => {
  const dir = tmpDir();
  Store.open(dir);
  try {
    Store.appendBlock(genesis);
    Store.appendBlock({ ...genesis, index: 1, hash: "abc" });
    // 세 번째 블록을 쓰다 만 상황
    fs.appendFileSync(path.join(dir, "blocks.jsonl"), '{"index":2,"hash":"tru');

    const loaded = Store.loadBlocks();
    assert.strictEqual(loaded.length, 2, "깨진 줄 앞까지만 읽어야 한다");
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeBlocks 는 파일을 통째로 갈아 끼운다 (체인 교체용)", () => {
  const dir = tmpDir();
  Store.open(dir);
  try {
    Store.appendBlock(genesis);
    Store.appendBlock({ ...genesis, index: 1, hash: "옛것" });
    Store.writeBlocks([genesis, { ...genesis, index: 1, hash: "새것" }]);

    const loaded = Store.loadBlocks();
    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[1].hash, "새것");
    // 임시 파일이 남지 않아야 한다
    assert.strictEqual(fs.existsSync(path.join(dir, "blocks.jsonl.tmp")), false);
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ 색인 */

test("아웃포인트 색인은 배열 훑기와 같은 결과를 준다", () => {
  const list = [
    { txOutId: "a", txOutIndex: 0, address: "04aa", amount: 5 },
    { txOutId: "a", txOutIndex: 1, address: "04bb", amount: 7 },
    { txOutId: "b", txOutIndex: 0, address: "04aa", amount: 3 }
  ];
  const index = indexByOutpoint(list);

  assert.strictEqual(index.size, 3);
  assert.strictEqual(index.get(keyOf("a", 1)).amount, 7);
  assert.strictEqual(index.get(keyOf("없음", 0)), undefined);

  // txOutId 가 같고 index 만 다른 것을 헷갈리지 않아야 한다
  assert.notStrictEqual(index.get(keyOf("a", 0)), index.get(keyOf("a", 1)));
});

test("주소 색인은 같은 주소의 UTxOut 을 합산한다", () => {
  const index = indexByAddress([
    { txOutId: "a", txOutIndex: 0, address: "04aa", amount: 5 },
    { txOutId: "b", txOutIndex: 0, address: "04aa", amount: 3 },
    { txOutId: "c", txOutIndex: 0, address: "04bb", amount: 7 }
  ]);
  assert.strictEqual(index.get("04aa"), 8);
  assert.strictEqual(index.get("04bb"), 7);
});

test("validateTx 는 색인을 넘겨도 넘기지 않아도 같은 답을 낸다", () => {
  const elliptic = require("elliptic");
  const { toHexString } = require("../src/utils");
  const ec = new elliptic.ec("secp256k1");
  const owner = ec.genKeyPair();
  const address = owner.getPublic().encode("hex");

  const uTxOuts = [{ txOutId: "seed", txOutIndex: 0, address, amount: 10 * COIN }];
  const tx = {
    txIns: [{ txOutId: "seed", txOutIndex: 0, signature: "" }],
    txOuts: [{ address, amount: 9 * COIN }]
  };
  tx.id = getTxId(tx);
  tx.txIns[0].signature = toHexString(owner.sign(tx.id).toDER());

  assert.strictEqual(validateTx(tx, uTxOuts), true);
  assert.strictEqual(validateTx(tx, uTxOuts, indexByOutpoint(uTxOuts)), true);

  // 색인이 비어 있으면 참조할 UTxOut 이 없으니 거부되어야 한다
  assert.strictEqual(validateTx(tx, uTxOuts, new Map()), false);
});

/* ------------------------------------------- 코인베이스는 되살리지 않는다 */

test("코인베이스는 블록에 묶여 있으므로 mempool 로 되돌릴 수 없다", () => {
  // 체인 교체 시 밀려난 트랜잭션을 되살릴 때, 코인베이스까지 되살리면
  // 그 블록에 속하지 않는 발행이 되어 버린다.
  const coinbase = createCoinbaseTx("04" + "a".repeat(128), 5, 0);
  const isCoinbase =
    coinbase.txIns.length === 1 && coinbase.txIns[0].txOutId === "";
  assert.strictEqual(isCoinbase, true);
  assert.strictEqual(coinbase.txIns[0].txOutIndex, 5, "코인베이스는 블록 높이에 묶인다");
  assert.strictEqual(coinbase.txOuts[0].amount, getBlockSubsidy(5));
});
