/**
 * 비트코인 백서에 근거해 추가한 기능들의 테스트.
 *
 *  - 6장 Incentive          : 수수료, 반감기
 *  - 7장 Reclaiming Disk Space: 머클 트리
 *  - 8장 SPV                 : 머클 증명
 */
const test = require("node:test");
const assert = require("node:assert");
const elliptic = require("elliptic");
const CryptoJS = require("crypto-js");

const {
  getTxId, validateTx, processTxs, createCoinbaseTx,
  getBlockSubsidy, getTotalSupply, getTxFee, HALVING_INTERVAL, INITIAL_SUBSIDY,
  MAX_TXS_PER_BLOCK
} = require("../src/transactions");
const { getMerkleRoot, getMerkleProof, verifyMerkleProof } = require("../src/merkle");
const { selectTxsForBlock } = require("../src/memPool");
const { COIN, parseLim, formatLim } = require("../src/units");
const { getTxProof } = require("../src/blockchain");
const genesis = require("../src/genesis.json");

const ec = new elliptic.ec("secp256k1");
const { toHexString } = require("../src/utils");

const makeWallet = () => {
  const keyPair = ec.genKeyPair();
  return { keyPair, address: keyPair.getPublic().encode("hex") };
};

// 소유자의 UTxOut 하나를 써서 receiver 에게 amount 를 보내고, 남는 만큼을
// 거스름돈으로 돌려받는 트랜잭션. 거스름돈을 줄이면 그만큼이 수수료가 된다.
const makeSpend = (owner, receiverAddress, inputAmount, sendAmount, changeAmount) => {
  const tx = {
    txIns: [{ txOutId: "seed", txOutIndex: 0, signature: "" }],
    txOuts: [{ address: receiverAddress, amount: sendAmount }]
  };
  if (changeAmount > 0) {
    tx.txOuts.push({ address: owner.address, amount: changeAmount });
  }
  tx.id = getTxId(tx);
  tx.txIns[0].signature = toHexString(owner.keyPair.sign(tx.id).toDER());
  return tx;
};

const seedUTxOuts = (owner, amount) => [
  { txOutId: "seed", txOutIndex: 0, address: owner.address, amount }
];

/* ---------------------------------------------------------- 최소 단위 */

test("최소 단위: 부동소수점을 거치지 않고 변환한다", () => {
  assert.strictEqual(parseLim("1.5"), 150000000);
  assert.strictEqual(parseLim("0.00000001"), 1);
  assert.strictEqual(parseLim("10"), 10 * COIN);
  assert.strictEqual(formatLim(150000000), "1.5");
  assert.strictEqual(formatLim(10 * COIN), "10");
  assert.strictEqual(formatLim(1), "0.00000001");
  // 0.1 + 0.2 문제가 생기지 않는다
  assert.strictEqual(parseLim("0.1") + parseLim("0.2"), parseLim("0.3"));
});

test("최소 단위: 표현할 수 없는 정밀도는 거부한다", () => {
  assert.throws(() => parseLim("0.000000001"));
  assert.throws(() => parseLim("abc"));
  assert.throws(() => parseLim("-1"));
});

test("금액은 최소 단위 기준 정수여야 한다", () => {
  const owner = makeWallet();
  const uTxOuts = seedUTxOuts(owner, 10 * COIN);
  // 소수 금액은 노드마다 반올림이 갈릴 수 있어 거부한다
  const tx = makeSpend(owner, owner.address, 10 * COIN, 1.5, 0);
  assert.strictEqual(validateTx(tx, uTxOuts), false);
});

/* -------------------------------------------- 6장 Incentive: 수수료 */

test("출력이 입력보다 적으면 차액이 수수료가 된다", () => {
  // 백서 6장: "If the output value of a transaction is less than its input
  // value, the difference is a transaction fee"
  const owner = makeWallet();
  const receiver = makeWallet();
  const uTxOuts = seedUTxOuts(owner, 10 * COIN);

  // 10 넣고 6 보내고 3.9 거슬러 받음 -> 수수료 0.1
  const tx = makeSpend(owner, receiver.address, 10 * COIN, 6 * COIN, parseLim("3.9"));

  assert.strictEqual(validateTx(tx, uTxOuts), true);
  assert.strictEqual(getTxFee(tx, uTxOuts), parseLim("0.1"));
});

test("출력이 입력보다 많으면 거부된다", () => {
  const owner = makeWallet();
  const uTxOuts = seedUTxOuts(owner, 10 * COIN);
  const tx = makeSpend(owner, owner.address, 10 * COIN, 11 * COIN, 0);
  assert.strictEqual(validateTx(tx, uTxOuts), false);
});

test("채굴자는 보조금에 더해 블록에 담긴 수수료를 가져간다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();
  const miner = makeWallet();
  const uTxOuts = seedUTxOuts(owner, 10 * COIN);

  const fee = parseLim("0.25");
  const spend = makeSpend(owner, receiver.address, 10 * COIN, 6 * COIN, 10 * COIN - 6 * COIN - fee);
  const coinbase = createCoinbaseTx(miner.address, 1, fee);

  assert.strictEqual(coinbase.txOuts[0].amount, getBlockSubsidy(1) + fee);

  const result = processTxs([coinbase, spend], uTxOuts, 1);
  assert.ok(Array.isArray(result), "수수료를 정확히 청구한 블록은 통과해야 한다");
});

test("담기지도 않은 수수료를 챙기는 코인베이스는 거부된다", () => {
  const miner = makeWallet();
  // 블록에 일반 트랜잭션이 없는데 수수료를 받은 것처럼 만든 코인베이스
  const greedy = createCoinbaseTx(miner.address, 1, parseLim("5"));
  assert.strictEqual(processTxs([greedy], [], 1), null);
});

test("수수료를 실제보다 많이 청구하면 거부된다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();
  const miner = makeWallet();
  const uTxOuts = seedUTxOuts(owner, 10 * COIN);

  const fee = parseLim("0.25");
  const spend = makeSpend(owner, receiver.address, 10 * COIN, 6 * COIN, 10 * COIN - 6 * COIN - fee);
  // 실제 수수료는 0.25 인데 1 을 청구
  const coinbase = createCoinbaseTx(miner.address, 1, parseLim("1"));

  assert.strictEqual(processTxs([coinbase, spend], uTxOuts, 1), null);
});

/* ------------------------------------------- 6장 Incentive: 반감기 */

test("보조금은 반감기마다 절반이 된다", () => {
  assert.strictEqual(getBlockSubsidy(0), INITIAL_SUBSIDY);
  assert.strictEqual(getBlockSubsidy(HALVING_INTERVAL - 1), INITIAL_SUBSIDY);
  assert.strictEqual(getBlockSubsidy(HALVING_INTERVAL), INITIAL_SUBSIDY / 2);
  assert.strictEqual(getBlockSubsidy(HALVING_INTERVAL * 2), INITIAL_SUBSIDY / 4);
  assert.strictEqual(getBlockSubsidy(HALVING_INTERVAL * 3), INITIAL_SUBSIDY / 8);
});

test("보조금은 결국 0 이 되고 그 뒤로는 수수료만 남는다", () => {
  // 백서 6장: "the incentive can transition entirely to transaction fees
  // and be completely inflation free"
  assert.strictEqual(getBlockSubsidy(HALVING_INTERVAL * 64), 0);
  assert.strictEqual(getBlockSubsidy(HALVING_INTERVAL * 100), 0);
});

test("총 발행량에 상한이 있다", () => {
  let supply = 0;
  for (let halving = 0; halving < 64; halving++) {
    const subsidy = getBlockSubsidy(halving * HALVING_INTERVAL);
    if (subsidy === 0) {
      break;
    }
    supply += subsidy * HALVING_INTERVAL;
  }
  // 예전에는 블록당 10 이 영원히 발행되어 상한이 없었다
  assert.ok(supply > 0);
  assert.ok(supply <= 2 * INITIAL_SUBSIDY * HALVING_INTERVAL);
  assert.ok(supply / COIN < 4_200_001, `총 발행량 ${formatLim(supply)} LIM`);
});

test("getTotalSupply 는 블록마다 더한 것과 같다", () => {
  /*
   * /info 가 4초마다 불리는 자리라 체인을 훑지 않고 구간별로 계산한다.
   * 결과가 하나라도 어긋나면 발행량 표시가 틀어진다.
   */
  const bruteForce = height => {
    let total = 0;
    for (let i = 0; i <= height; i++) {
      total += getBlockSubsidy(i);
    }
    return total;
  };

  for (const height of [0, 1, 9, 1000, HALVING_INTERVAL - 1, HALVING_INTERVAL, HALVING_INTERVAL + 1]) {
    assert.strictEqual(getTotalSupply(height), bruteForce(height), `높이 ${height}`);
  }
});

test("총 발행량은 반감이 거듭돼도 상한을 넘지 않는다", () => {
  const cap = getTotalSupply(HALVING_INTERVAL * 200);
  assert.strictEqual(getTotalSupply(HALVING_INTERVAL * 1000), cap, "더 가도 늘지 않는다");
  assert.ok(cap / COIN < 4_200_001, `총 발행량 ${formatLim(cap)} LIM`);
});

/* --------------------------------- 7장/8장: 머클 트리와 SPV 증명 */

const fakeTxs = n =>
  Array.from({ length: n }, (_, i) => ({ id: CryptoJS.SHA256("tx" + i).toString() }));

test("머클 루트는 트랜잭션이 하나만 바뀌어도 달라진다", () => {
  const txs = fakeTxs(4);
  const before = getMerkleRoot(txs);
  const after = getMerkleRoot([...txs.slice(0, 3), { id: CryptoJS.SHA256("다른것").toString() }]);
  assert.notStrictEqual(before, after);
});

test("머클 증명은 개수와 무관하게 log2(n) 개 해시로 끝난다", () => {
  // 백서 7장: "transactions are hashed in a Merkle Tree, with only the root
  // included in the block's hash"
  for (const n of [1, 2, 3, 4, 5, 8, 9, 16, 17, 100]) {
    const txs = fakeTxs(n);
    const root = getMerkleRoot(txs);
    const proof = getMerkleProof(txs, txs[0].id);
    assert.strictEqual(proof.length, Math.ceil(Math.log2(n)), `${n}개일 때`);
    assert.strictEqual(verifyMerkleProof(txs[0].id, proof, root), true);
  }
});

test("모든 트랜잭션에 대해 증명이 검증된다 (홀수 개 포함)", () => {
  for (const n of [1, 3, 5, 7, 9, 11]) {
    const txs = fakeTxs(n);
    const root = getMerkleRoot(txs);
    for (const tx of txs) {
      assert.strictEqual(
        verifyMerkleProof(tx.id, getMerkleProof(txs, tx.id), root),
        true,
        `${n}개 중 ${tx.id.slice(0, 8)}`
      );
    }
  }
});

test("없는 트랜잭션의 증명은 만들어지지 않고, 위조 증명은 거부된다", () => {
  const txs = fakeTxs(4);
  const root = getMerkleRoot(txs);
  assert.strictEqual(getMerkleProof(txs, "존재하지않는id"), null);
  // 다른 트랜잭션의 증명을 가져다 붙여도 통과하지 않는다
  assert.strictEqual(
    verifyMerkleProof(txs[0].id, getMerkleProof(txs, txs[1].id), root),
    false
  );
  assert.strictEqual(verifyMerkleProof(txs[0].id, [], root), false);
});

test("제네시스 블록의 머클 루트가 본문과 일치한다", () => {
  assert.strictEqual(typeof genesis.merkleRoot, "string");
  assert.strictEqual(getMerkleRoot(genesis.data), genesis.merkleRoot);
});

test("체인에 담긴 트랜잭션의 SPV 증명을 내준다", () => {
  const genesisTxId = genesis.data[0].id;
  const proof = getTxProof(genesisTxId);
  assert.ok(proof, "제네시스 트랜잭션의 증명이 있어야 한다");
  assert.strictEqual(proof.blockIndex, 0);
  assert.strictEqual(
    verifyMerkleProof(genesisTxId, proof.proof, proof.merkleRoot),
    true
  );
  assert.strictEqual(getTxProof("존재하지않는id"), null);
});

/* ------------------------------------- 블록 한도와 수수료 우선순위 */

test("블록 한도를 넘는 트랜잭션 수는 거부된다", () => {
  const miner = makeWallet();
  const txs = [createCoinbaseTx(miner.address, 1, 0), ...fakeTxs(MAX_TXS_PER_BLOCK)];
  assert.strictEqual(processTxs(txs, [], 1), null);
});

test("블록에 담을 때 수수료율이 높은 트랜잭션이 먼저 선택된다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();

  // 입력 하나짜리 트랜잭션 셋을 수수료만 다르게 만든다
  const build = (fee, seed) => {
    const uTxOut = { txOutId: seed, txOutIndex: 0, address: owner.address, amount: 10 * COIN };
    const tx = {
      txIns: [{ txOutId: seed, txOutIndex: 0, signature: "" }],
      txOuts: [
        { address: receiver.address, amount: 5 * COIN },
        { address: owner.address, amount: 5 * COIN - fee }
      ]
    };
    tx.id = getTxId(tx);
    tx.txIns[0].signature = toHexString(owner.keyPair.sign(tx.id).toDER());
    return { tx, uTxOut, fee };
  };

  const low = build(parseLim("0.01"), "a");
  const mid = build(parseLim("0.5"), "b");
  const high = build(parseLim("2"), "c");
  const uTxOuts = [low.uTxOut, mid.uTxOut, high.uTxOut];

  const picked = selectTxsForBlock([low.tx, mid.tx, high.tx], uTxOuts, 2);

  assert.strictEqual(picked.length, 2);
  assert.deepStrictEqual(
    picked.map(tx => getTxFee(tx, uTxOuts)),
    [high.fee, mid.fee],
    "수수료가 높은 순으로 담겨야 한다"
  );
});

test("한 블록에 같은 id 의 트랜잭션이 두 번 들어오면 거부된다", () => {
  // 머클 트리가 홀수 잎을 복제해 채우는 성질 때문에 서로 다른 집합이 같은
  // 루트를 갖게 만들 수 있다 (비트코인 CVE-2012-2459)
  const miner = makeWallet();
  const coinbase = createCoinbaseTx(miner.address, 1, 0);
  assert.strictEqual(processTxs([coinbase, coinbase], [], 1), null);
});
