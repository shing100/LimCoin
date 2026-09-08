/**
 * 채굴 워커 풀 — 취소가 promise 를 끝내는지, 워커가 죽어도 다음 채굴이 되는지.
 */
const test = require("node:test");
const assert = require("node:assert");

const Blockchain = require("../src/blockchain");
const {
  findBlockInWorkers,
  getMinerPool,
  stopMiners,
  getBlockChain
} = Blockchain;
const Mempool = require("../src/memPool");
const { createCoinbaseTx, getTxId } = require("../src/transactions");
const { toHexString } = require("../src/utils");
const PoW = require("../src/pow");
const { newAddress, ecShim, coinbaseBlockOnto } = require("./helpers");

const genesis = getBlockChain()[0];
const data = () => [createCoinbaseTx(newAddress(), 1, 0)];
const mine = difficulty =>
  findBlockInWorkers(1, genesis.hash, genesis.timestamp + 1, data(), difficulty);

test.after(() => stopMiners());

test("cancel() 은 채굴 promise 를 거절로 끝내고, 풀은 다음 일감을 받는다", async () => {
  // 난이도 60 은 끝나지 않는다 — 취소로만 풀린다
  const mining = mine(60);
  mining.cancel("다른 블록이 먼저 왔다");
  await assert.rejects(mining, /다른 블록이 먼저 왔다/);

  // 수정 전에는 취소가 promise 를 끝내지 않아 리스너가 워커에 쌓였다
  for (const worker of getMinerPool()) {
    assert.strictEqual(worker.listenerCount("message"), 0);
    assert.strictEqual(worker.listenerCount("error"), 0);
  }

  const block = await mine(1);
  assert.strictEqual(block.index, 1);
  assert.strictEqual(block.previousHash, genesis.hash);
  assert.ok(PoW.hashMatchesDifficulty(block.hash, 1));
  assert.strictEqual(
    PoW.createHash(block.index, block.previousHash, block.timestamp, block.merkleRoot, block.difficulty, block.nonce),
    block.hash
  );
});

test("이미 끝난 채굴을 취소해도 아무 일도 없다", async () => {
  const mining = mine(1);
  const block = await mining;
  mining.cancel("늦은 취소");
  assert.ok(block.hash);
});

test("워커가 죽으면 풀을 버리고 다음 채굴이 새로 띄운다", async () => {
  const pool = getMinerPool();
  assert.ok(pool.length >= 1);

  await pool[0].terminate();
  // exit 핸들러가 돌 시간을 준다
  await new Promise(resolve => setImmediate(resolve));

  // 수정 전에는 죽은 워커가 풀에 남아 그 워커의 일감은 영원히 답이 없었다
  const fresh = getMinerPool();
  assert.notStrictEqual(fresh, pool);
  const block = await mine(1);
  assert.ok(PoW.hashMatchesDifficulty(block.hash, 1));
});

test("채굴 중 새 트랜잭션이 오면 템플릿을 다시 만들어 지금 파는 블록에 담는다", async () => {
  // 우리 키로 코인베이스를 받는 체인을 만들어 쓸 돈을 마련한다 (성숙도 10 블록)
  const miner = ecShim.genKeyPair();
  const minerAddress = miner.getPublic().encode("hex"); // 예전 형식 주소(공개키 hex)
  const genesis = getBlockChain()[0];
  let chain = [genesis];
  for (let i = 0; i < 11; i++) {
    const tip = coinbaseBlockOnto(
      chain[chain.length - 1], minerAddress, i * 10, Blockchain.difficultyForNext(chain)
    );
    chain = chain.concat([tip]);
  }
  assert.strictEqual(Blockchain.replaceChain(chain), true);
  assert.strictEqual(getBlockChain().length, 12);

  // 1번 블록의 코인베이스(10 LIM)를 쓴다 — 높이 12에서는 성숙했다
  const coinbase = chain[1].data[0];
  const tx = {
    txIns: [{ txOutId: coinbase.id, txOutIndex: 0, signature: "" }],
    txOuts: [{ address: newAddress(), amount: coinbase.txOuts[0].amount - 1000000 }]
  };
  tx.id = getTxId(tx);
  tx.txIns[0].signature = toHexString(miner.sign(tx.id).toDER());

  process.env.LIMCOIN_MINING_ADDRESS = minerAddress;
  try {
    // 코인베이스만 든 템플릿으로 채굴을 시작한 뒤(아직 이벤트 루프에 양보하지 않았다)
    const mining = Blockchain.createNewBlock();
    assert.strictEqual(Mempool.getMempool().length, 0);
    // 트랜잭션이 들어온다 — 예전에는 이 트랜잭션은 다음 블록을 기다렸다
    Blockchain.submitTx(tx);
    const block = await mining;

    assert.strictEqual(block.index, 12);
    assert.strictEqual(block.data.length, 2);
    assert.strictEqual(block.data[1].id, tx.id);
    // 수수료(0.01 LIM)는 코인베이스로 갔다
    assert.strictEqual(block.data[0].txOuts[0].amount, chain[1].data[0].txOuts[0].amount + 1000000);
    assert.strictEqual(getBlockChain().length, 13);
    assert.strictEqual(Mempool.getMempool().length, 0);
  } finally {
    delete process.env.LIMCOIN_MINING_ADDRESS;
  }
});
