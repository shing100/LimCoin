/**
 * 시작 비용과 되감기 상한.
 *
 * 되감기 상한을 2로 줄여 놓고 돌린다(노드 설정과 같은 환경 변수).
 */
process.env.LIMCOIN_MAX_REORG_DEPTH = "2";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Store = require("../src/store");
const Params = require("../src/params");
const Blockchain = require("../src/blockchain");
const { getBlockChain, getUTxOutList, replaceChain, initChain, persistChainstate } = Blockchain;
const { mineChainOnto, coinbaseBlockOnto, newAddress } = require("./helpers");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "limcoin-state-"));

/* ------------------------------------------- 저장 */

test("chainstate 는 저장하고 읽어 온다. 깨져 있으면 없는 셈 친다", () => {
  const dir = tmpDir();
  Store.open(dir);
  try {
    assert.strictEqual(Store.loadChainstate(), null, "없으면 null");

    const state = { version: 1, height: 3, tipHash: "aa", uTxOuts: [{ amount: 1 }], undo: [[]] };
    Store.saveChainstate(state);
    assert.deepStrictEqual(Store.loadChainstate(), state);

    // 반쯤 쓰인 파일이 남아도 노드가 죽지 않는다
    fs.writeFileSync(path.join(dir, "chainstate.json"), "{깨진");
    assert.strictEqual(Store.loadChainstate(), null);

    Store.dropChainstate();
    assert.strictEqual(Store.loadChainstate(), null);
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- 스냅샷으로 뜨기 */

test("스냅샷이 있으면 체인을 다시 검증하지 않고 뜬다", () => {
  const dir = tmpDir();
  try {
    // 블록 몇 개를 쌓아 디스크에 남긴다
    initChain(dir);
    const mined = mineChainOnto(getBlockChain()[0], 6);
    assert.strictEqual(replaceChain([getBlockChain()[0], ...mined]), true);
    const expectedUTxOuts = getUTxOutList();
    const expectedTip = getBlockChain()[getBlockChain().length - 1];
    persistChainstate();

    // 다시 뜬다 — 스냅샷이 맞으므로 재생하지 않는다
    const fast = initChain(dir);
    assert.strictEqual(fast.fromSnapshot, true);
    assert.strictEqual(fast.height, expectedTip.index);
    assert.strictEqual(getBlockChain()[getBlockChain().length - 1].hash, expectedTip.hash);
    assert.deepStrictEqual(
      getUTxOutList().map(u => `${u.txOutId}:${u.txOutIndex}`).sort(),
      expectedUTxOuts.map(u => `${u.txOutId}:${u.txOutIndex}`).sort(),
      "UTxOut 집합이 재생한 것과 같아야 한다"
    );
    // 색인도 함께 다시 만들어져 있어야 한다
    assert.strictEqual(Blockchain.getBlockByHash(expectedTip.hash).index, expectedTip.index);

    // 스냅샷을 버리면 예전처럼 전부 재생한다 — 결과는 같아야 한다
    Store.open(dir);
    Store.dropChainstate();
    const slow = initChain(dir);
    assert.strictEqual(slow.fromSnapshot, false);
    assert.strictEqual(slow.height, expectedTip.index);
    assert.deepStrictEqual(
      getUTxOutList().map(u => `${u.txOutId}:${u.txOutIndex}`).sort(),
      expectedUTxOuts.map(u => `${u.txOutId}:${u.txOutIndex}`).sort()
    );
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("끝 블록이 스냅샷과 다르면 스냅샷을 믿지 않는다", () => {
  const dir = tmpDir();
  try {
    initChain(dir);
    const mined = mineChainOnto(getBlockChain()[0], 3);
    replaceChain([getBlockChain()[0], ...mined]);
    persistChainstate();

    // 스냅샷의 끝 해시를 손댄다 (파일을 고쳤거나 도중에 죽은 경우)
    Store.open(dir);
    const state = Store.loadChainstate();
    Store.saveChainstate({ ...state, tipHash: "0".repeat(64) });

    const restored = initChain(dir);
    assert.strictEqual(restored.fromSnapshot, false, "어긋나면 전부 재생한다");
    assert.strictEqual(restored.height, 3);
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- 되감기 상한 */

test("상한보다 깊이 되감으라는 체인은 더 무거워도 받지 않는다", () => {
  const dir = tmpDir();
  try {
    initChain(dir);
    assert.strictEqual(Blockchain.MAX_REORG_DEPTH, 2);

    const genesis = getBlockChain()[0];
    const ours = mineChainOnto(genesis, 4);
    assert.strictEqual(replaceChain([genesis, ...ours]), true);
    const tip = getBlockChain()[getBlockChain().length - 1].hash;

    // 제네시스부터 다시 캔 더 긴 체인 — 4블록을 되감으라는 뜻이다
    const rival = mineChainOnto(genesis, 6, 1000, [genesis]);
    assert.ok(
      Blockchain.chainWork([genesis, ...rival]) > Blockchain.chainWork(getBlockChain()),
      "더 무거운 체인이어야 시험이 된다"
    );
    assert.strictEqual(replaceChain([genesis, ...rival]), false, "상한을 넘으면 거부");
    assert.strictEqual(getBlockChain()[getBlockChain().length - 1].hash, tip, "우리 체인 그대로");

    // 상한 안쪽(2블록)이면 받아들인다
    const shallow = mineChainOnto(getBlockChain()[2], 4, 2000);
    assert.strictEqual(replaceChain([...getBlockChain().slice(0, 3), ...shallow]), true);
    assert.strictEqual(getBlockChain().length, 7);
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- 체크포인트 */

test("체크포인트와 다른 블록은 받지 않는다", () => {
  const params = Params.current();
  const genesis = getBlockChain()[0];
  const block = coinbaseBlockOnto(genesis, newAddress(), 5000, Blockchain.bitsForNext([genesis]));

  // 그 높이에 다른 해시를 못박아 둔다
  params.checkpoints.push([1, "9".repeat(64)]);
  try {
    assert.strictEqual(Blockchain.isBlockValid(block, [genesis]), false);
    // 해시가 맞으면 통과한다
    params.checkpoints[params.checkpoints.length - 1] = [1, block.hash];
    assert.strictEqual(Blockchain.isBlockValid(block, [genesis]), true);
    // 체크포인트가 없는 높이는 상관없다
    params.checkpoints[params.checkpoints.length - 1] = [99, "9".repeat(64)];
    assert.strictEqual(Blockchain.isBlockValid(block, [genesis]), true);
  } finally {
    params.checkpoints.pop();
  }
});
