/**
 * 블록 본문은 디스크에, 헤더만 메모리에.
 *
 * 본문 캐시를 2개로 줄여 놓고 돌린다 — 조금만 지나면 반드시 디스크에서
 * 읽게 되므로, 게으른 읽기가 실제로 도는지 확인할 수 있다.
 */
process.env.LIMCOIN_BLOCK_CACHE = "2";
process.env.LIMCOIN_NETWORK = "regtest";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Store = require("../src/store");
const Blockchain = require("../src/blockchain");
const { getBlockChain, initChain, replaceChain, addBlockToChain } = Blockchain;
const { getMerkleRoot } = require("../src/merkle");
const { mineChainOnto, coinbaseBlockOnto, newAddress, timestampFor } = require("./helpers");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "limcoin-store-"));
const lines = dir => fs.readFileSync(path.join(dir, "blocks.jsonl"), "utf8").trim().split("\n").length;

/* ------------------------------------------- 저장소 */

test("블록 하나만 읽고, 잘라 내고, 이어 붙인다", () => {
  const dir = tmpDir();
  Store.open(dir);
  try {
    for (let i = 0; i < 5; i++) {
      Store.appendBlock({ index: i, hash: `h${i}`, data: [{ id: `t${i}` }] });
    }
    assert.strictEqual(Store.blockCount(), 5);
    assert.strictEqual(Store.readBlockAt(0).hash, "h0");
    assert.strictEqual(Store.readBlockAt(4).data[0].id, "t4");
    assert.strictEqual(Store.readBlockAt(5), null, "없는 높이는 null");
    assert.strictEqual(Store.readBlockAt(-1), null);

    // 다시 훑어도 같은 자리를 가리켜야 한다
    const seen = [];
    assert.strictEqual(Store.scanBlocks(block => seen.push(block.hash)), 5);
    assert.deepStrictEqual(seen, ["h0", "h1", "h2", "h3", "h4"]);
    assert.strictEqual(Store.readBlockAt(3).hash, "h3");

    // 잘라 내면 파일도 줄어든다 (예전에는 통째로 다시 썼다)
    Store.truncateBlocksTo(3);
    assert.strictEqual(Store.blockCount(), 3);
    assert.strictEqual(lines(dir), 3);
    assert.strictEqual(Store.readBlockAt(3), null);

    // 잘라 낸 자리에 이어 붙는다
    Store.appendBlock({ index: 3, hash: "new3", data: [] });
    assert.strictEqual(Store.readBlockAt(3).hash, "new3");
    assert.strictEqual(lines(dir), 4);
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("마지막 줄이 깨져 있으면 거기까지만 읽고 잘라 낸다", () => {
  const dir = tmpDir();
  Store.open(dir);
  try {
    Store.appendBlock({ index: 0, hash: "h0", data: [] });
    Store.appendBlock({ index: 1, hash: "h1", data: [] });
    fs.appendFileSync(path.join(dir, "blocks.jsonl"), '{"index":2,"hash":"잘');

    const seen = [];
    assert.strictEqual(Store.scanBlocks(block => seen.push(block.hash)), 2);
    assert.deepStrictEqual(seen, ["h0", "h1"]);
    assert.strictEqual(lines(dir), 2, "깨진 줄은 잘라 낸다");

    // 그 뒤로 이어 붙일 수 있어야 한다
    Store.appendBlock({ index: 2, hash: "h2", data: [] });
    assert.strictEqual(Store.readBlockAt(2).hash, "h2");
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- 체인 */

test("메모리에는 헤더만 두고 본문은 그때그때 읽어 온다", () => {
  const dir = tmpDir();
  try {
    initChain(dir);
    const genesis = getBlockChain()[0];
    const mined = mineChainOnto(genesis, 8);
    assert.strictEqual(replaceChain([genesis, ...mined]), true);

    const chain = getBlockChain();
    assert.strictEqual(chain.length, 9);

    // 캐시가 2개뿐이라 앞쪽 블록의 본문은 이미 메모리에 없다.
    // 그래도 읽으면 나와야 하고, 머클 루트가 맞아야 한다.
    for (const block of chain) {
      assert.ok(Array.isArray(block.data), `#${block.index} 본문`);
      assert.strictEqual(getMerkleRoot(block.data), block.merkleRoot, `#${block.index} 머클`);
    }
    // JSON 으로 내보낼 때도 본문이 함께 나가야 한다 (API 응답)
    const serialized = JSON.parse(JSON.stringify(chain[1]));
    assert.strictEqual(serialized.data.length, chain[1].data.length);
    assert.strictEqual(serialized.hash, chain[1].hash);
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("체인을 갈아 끼우면 파일은 갈라진 지점부터 잘리고 새 블록만 붙는다", () => {
  const dir = tmpDir();
  try {
    initChain(dir);
    const genesis = getBlockChain()[0];
    const ours = mineChainOnto(genesis, 3);
    replaceChain([genesis, ...ours]);
    assert.strictEqual(lines(dir), 4);

    // 2번 블록에서 갈라지는 더 긴 체인
    const forkAt = getBlockChain()[2];
    const rival = mineChainOnto(forkAt, 4, 500);
    assert.strictEqual(replaceChain([...getBlockChain().slice(0, 3), ...rival]), true);

    assert.strictEqual(getBlockChain().length, 7);
    assert.strictEqual(lines(dir), 7, "파일도 같은 길이여야 한다");
    // 밀려난 블록은 파일에서 사라지고, 새 블록이 그 자리에 있다
    assert.strictEqual(Store.readBlockAt(3).hash, rival[0].hash);
    assert.strictEqual(Store.readBlockAt(6).hash, rival[3].hash);
    // 갈라지기 전 블록은 그대로다
    assert.strictEqual(Store.readBlockAt(2).hash, forkAt.hash);
    // 본문도 제대로 읽힌다
    for (const block of getBlockChain()) {
      assert.strictEqual(getMerkleRoot(block.data), block.merkleRoot);
    }
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("다시 떠도 본문을 디스크에서 읽어 같은 체인을 본다", () => {
  const dir = tmpDir();
  try {
    initChain(dir);
    const genesis = getBlockChain()[0];
    const mined = mineChainOnto(genesis, 5);
    replaceChain([genesis, ...mined]);
    const before = getBlockChain().map(block => ({ hash: block.hash, txs: block.data.length }));
    Blockchain.persistChainstate();

    const restarted = initChain(dir);
    assert.strictEqual(restarted.height, 5);
    assert.strictEqual(restarted.fromSnapshot, true);
    const after = getBlockChain().map(block => ({ hash: block.hash, txs: block.data.length }));
    assert.deepStrictEqual(after, before);

    // 새 블록도 계속 붙는다
    const tip = getBlockChain()[5];
    const when = timestampFor(tip, 60);
    const next = coinbaseBlockOnto(
      tip, newAddress(), 60, Blockchain.bitsForNext(getBlockChain(), when)
    );
    assert.strictEqual(addBlockToChain(next), true);
    assert.strictEqual(lines(dir), 7);
    assert.strictEqual(Store.readBlockAt(6).hash, next.hash);
  } finally {
    Store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
