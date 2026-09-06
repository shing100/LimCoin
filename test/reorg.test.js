/**
 * 체인 교체(reorg).
 *
 * 두 가지를 본다.
 *
 *  1. 되감기(undo) 로 얻은 UTxOut 집합이 제네시스부터 재생한 것과 같은가
 *  2. 작업증명을 하지 않은 체인이 난이도를 크게 적어 끼어들지 못하는가
 */
const test = require("node:test");
const assert = require("node:assert");
const elliptic = require("elliptic");

const {
  collectConsumed,
  rollbackTxs,
  updateUTxOuts,
  processTxs,
  createCoinbaseTx,
  getTxId
} = require("../src/transactions");
const { getMerkleRoot } = require("../src/merkle");
const PoW = require("../src/pow");
const { outpointKey } = require("../src/utxo");
const { toHexString } = require("../src/utils");
const { COIN } = require("../src/units");

const ec = new elliptic.ec("secp256k1");
const newAddress = () => ec.genKeyPair().getPublic().encode("hex");

/* ------------------------------------------- undo 데이터 자체 */

const seed = (id, address, amount) => ({
  txOutId: id,
  txOutIndex: 0,
  address,
  amount
});

const sortedKeys = list => list.map(outpointKey).sort();

test("되감기는 블록을 적용하기 전 상태를 그대로 되돌린다", () => {
  const alice = ec.genKeyPair();
  const aliceAddress = alice.getPublic().encode("hex");
  const bob = newAddress();

  const before = [seed("s1", aliceAddress, 10 * COIN), seed("s2", aliceAddress, 5 * COIN)];

  const tx = {
    txIns: [{ txOutId: "s1", txOutIndex: 0, signature: "" }],
    txOuts: [{ address: bob, amount: 10 * COIN }]
  };
  tx.id = getTxId(tx);
  tx.txIns[0].signature = toHexString(alice.sign(tx.id).toDER());

  const consumed = collectConsumed([tx], before);
  const after = updateUTxOuts([tx], before);

  assert.deepStrictEqual(sortedKeys(consumed), ["s1:0"]);
  assert.deepStrictEqual(sortedKeys(after), [`${tx.id}:0`, "s2:0"].sort());
  assert.deepStrictEqual(
    sortedKeys(rollbackTxs([tx], after, consumed)),
    sortedKeys(before)
  );
});

test("한 블록 안에서 만들어졌다 쓰인 출력은 되감아도 되살아나지 않는다", () => {
  const alice = ec.genKeyPair();
  const aliceAddress = alice.getPublic().encode("hex");
  const bob = newAddress();

  const before = [seed("s1", aliceAddress, 10 * COIN)];

  // t1: alice -> alice, t2: t1 의 출력을 바로 써서 bob 에게
  const t1 = { txIns: [{ txOutId: "s1", txOutIndex: 0, signature: "" }], txOuts: [{ address: aliceAddress, amount: 10 * COIN }] };
  t1.id = getTxId(t1);
  t1.txIns[0].signature = toHexString(alice.sign(t1.id).toDER());

  const t2 = { txIns: [{ txOutId: t1.id, txOutIndex: 0, signature: "" }], txOuts: [{ address: bob, amount: 10 * COIN }] };
  t2.id = getTxId(t2);
  t2.txIns[0].signature = toHexString(alice.sign(t2.id).toDER());

  const txs = [t1, t2];
  const consumed = collectConsumed(txs, before);
  const after = updateUTxOuts(txs, before);

  // t1 의 출력은 블록 적용 *전* 집합에 없으므로 undo 에도 담기지 않는다
  assert.deepStrictEqual(sortedKeys(consumed), ["s1:0"]);
  assert.deepStrictEqual(sortedKeys(after), [`${t2.id}:0`]);
  assert.deepStrictEqual(
    sortedKeys(rollbackTxs(txs, after, consumed)),
    sortedKeys(before)
  );
});

/* ------------------------------------------- 실제 체인 교체 */

const Blockchain = require("../src/blockchain");
const AddressIndex = require("../src/addressIndex");
const genesis = require("../src/genesis.json");

const { getBlockChain, addBlockToChain, replaceChain, getUTxOutList, difficultyForNext } = Blockchain;

const now = Math.round(Date.now() / 1000);

// 실제로 nonce 를 찾아 블록을 만든다. 제네시스 난이도(15) 기준 수만 번이면 된다.
const mineOnto = (previousBlock, data, offset = 0) => {
  const index = previousBlock.index + 1;
  const timestamp = now + offset;
  const merkleRoot = getMerkleRoot(data);
  const difficulty = previousBlock.difficulty;
  const header = { index, previousHash: previousBlock.hash, timestamp, merkleRoot, difficulty };

  for (let from = 0; ; from += 200000) {
    const found = PoW.findNonce(header, from, 200000);
    if (found !== null) {
      return {
        index,
        hash: found.hash,
        previousHash: previousBlock.hash,
        timestamp,
        merkleRoot,
        data,
        difficulty,
        nonce: found.nonce
      };
    }
  }
};

const coinbaseBlockOnto = (previousBlock, address, offset) =>
  mineOnto(previousBlock, [createCoinbaseTx(address, previousBlock.index + 1, 0)], offset);

test("갈라진 체인으로 갈아 끼워도 UTxOut 과 주소 색인이 재생한 것과 같다", () => {
  // 우리 체인: genesis - A1 - A2 - A3
  const a1Address = newAddress();
  const a2Address = newAddress();
  const a3Address = newAddress();

  const a1 = coinbaseBlockOnto(genesis, a1Address, 1);
  assert.strictEqual(addBlockToChain(a1), true, "A1 이 붙어야 한다");
  const a2 = coinbaseBlockOnto(a1, a2Address, 2);
  assert.strictEqual(addBlockToChain(a2), true, "A2 가 붙어야 한다");
  const a3 = coinbaseBlockOnto(a2, a3Address, 3);
  assert.strictEqual(addBlockToChain(a3), true, "A3 이 붙어야 한다");

  assert.strictEqual(getBlockChain().length, 4);
  assert.ok(AddressIndex.hasAddress(a2Address), "A2 채굴자가 색인에 있어야 한다");

  // 상대 체인: genesis - A1 - B2 - B3 - B4 (A1 까지는 같다)
  const b2Address = newAddress();
  const b3Address = newAddress();
  const b4Address = newAddress();

  const b2 = coinbaseBlockOnto(a1, b2Address, 4);
  const b3 = coinbaseBlockOnto(b2, b3Address, 5);
  const b4 = coinbaseBlockOnto(b3, b4Address, 6);
  const rival = [genesis, a1, b2, b3, b4];

  assert.strictEqual(replaceChain(rival), true, "더 무거운 체인으로 갈아 끼워야 한다");
  assert.strictEqual(getBlockChain().length, 5);
  assert.strictEqual(Blockchain.getNewestBlock().hash, b4.hash);

  // 되감기로 얻은 UTxOut 집합 == 제네시스부터 재생한 것
  let replayed = [];
  for (const block of rival) {
    replayed = updateUTxOuts(block.data, replayed);
  }
  assert.deepStrictEqual(sortedKeys(getUTxOutList()), sortedKeys(replayed));

  // 밀려난 블록의 채굴자는 색인에서 사라지고, 새 블록의 채굴자는 들어와야 한다
  assert.strictEqual(AddressIndex.hasAddress(a1Address), true, "공통 접두사는 남는다");
  assert.strictEqual(AddressIndex.hasAddress(a2Address), false, "밀려난 A2 는 사라진다");
  assert.strictEqual(AddressIndex.hasAddress(a3Address), false, "밀려난 A3 은 사라진다");
  for (const address of [b2Address, b3Address, b4Address]) {
    assert.strictEqual(AddressIndex.hasAddress(address), true);
    const { transactions } = AddressIndex.getTransactions(address);
    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].coinbase, true);
  }
});

/* ------------------------------------------- 작업증명 위조 */

test("난이도는 그 높이에서 프로토콜이 정한 값이어야 한다", () => {
  const chain = getBlockChain();
  const expected = difficultyForNext(chain);
  const tip = chain[chain.length - 1];

  const cheap = coinbaseBlockOnto(tip, newAddress(), 10);
  // 난이도만 낮춰 적고 해시는 그대로 두면 해시가 어긋나 걸린다.
  // 진짜 문제는 낮은 난이도로 *다시 채굴한* 블록이므로 그렇게 만든다.
  const forged = { ...cheap, difficulty: expected - 1 };
  const header = { ...forged, previousHash: tip.hash };
  const found = PoW.findNonce(header, 0, 500000);
  forged.nonce = found.nonce;
  forged.hash = found.hash;

  assert.strictEqual(addBlockToChain(forged), false);
});

test("작업증명 없이 난이도만 크게 적은 체인은 우리 체인을 넘어서지 못한다", () => {
  /*
   * sumDifficulty 는 2^difficulty 의 합이다. difficulty 에 200 을 적으면
   * 정직한 체인을 단번에 넘어선다. 해시가 그 난이도를 만족하는지 보지
   * 않으면 일 한 번 안 하고 체인을 갈아 끼울 수 있었다.
   */
  const data = [createCoinbaseTx(newAddress(), 1, 0)];
  const merkleRoot = getMerkleRoot(data);
  const forged = {
    index: 1,
    previousHash: genesis.hash,
    timestamp: now,
    merkleRoot,
    data,
    difficulty: 200,
    nonce: 0
  };
  forged.hash = PoW.createHash(
    forged.index, forged.previousHash, forged.timestamp,
    forged.merkleRoot, forged.difficulty, forged.nonce
  );

  const before = getBlockChain().length;
  assert.strictEqual(replaceChain([genesis, forged]), false);
  assert.strictEqual(getBlockChain().length, before, "체인이 그대로여야 한다");
});
