/**
 * 검증 로직 회귀 테스트.
 * 여기 있는 케이스는 전부 수정 전에는 통과(=공격 성공)하던 것들이다.
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  getTxId,
  validateTx,
  processTxs,
  createCoinbaseTx,
  isAddressValid,
  getBlockSubsidy
} = require("../src/transactions");
const { toHexString } = require("../src/utils");
const { calculateNewDifficulty, difficultyForNext, replaceChain } = require("../src/blockchain");
const genesis = require("../src/genesis.json");

const { ecShim: ec, fakeId } = require("./helpers");

const makeWallet = () => {
  const keyPair = ec.genKeyPair();
  return {
    keyPair,
    privateKey: keyPair.getPrivate().toString(16),
    address: keyPair.getPublic().encode("hex")
  };
};

// 서명은 tx.id 위에 이뤄지므로, id 를 먼저 확정한 뒤 서명한다.
const signWith = (keyPair, txId) => toHexString(keyPair.sign(txId).toDER());

test("getTxId 는 내용이 같으면 같은 id 를, 다르면 다른 id 를 만든다", () => {
  const a = { txIns: [{ txOutId: "a".repeat(64), txOutIndex: 0 }], txOuts: [{ address: "04ab", amount: 1 }] };
  const b = { txIns: [{ txOutId: "a".repeat(64), txOutIndex: 0 }], txOuts: [{ address: "04ab", amount: 2 }] };
  assert.strictEqual(getTxId(a), getTxId(a));
  assert.notStrictEqual(getTxId(a), getTxId(b));
});

test("남의 UTxOut 을 자기 키로 서명한 tx 는 거부된다", () => {
  // 수정 전: validateTx 가 배열에 ! 를 씌워 검증 결과를 통째로 버려 true 를 돌려줬다.
  const victim = makeWallet();
  const attacker = makeWallet();

  const uTxOuts = [
    { txOutId: fakeId("seed"), txOutIndex: 0, address: victim.address, amount: 10 }
  ];

  const tx = {
    txIns: [{ txOutId: fakeId("seed"), txOutIndex: 0, signature: "" }],
    txOuts: [{ address: attacker.address, amount: 10 }]
  };
  tx.id = getTxId(tx);
  tx.txIns[0].signature = signWith(attacker.keyPair, tx.id);

  assert.strictEqual(validateTx(tx, uTxOuts), false);
});

test("올바르게 서명한 tx 는 통과한다", () => {
  const owner = makeWallet();
  const receiver = makeWallet();

  const uTxOuts = [
    { txOutId: fakeId("seed"), txOutIndex: 0, address: owner.address, amount: 10 }
  ];

  const tx = {
    txIns: [{ txOutId: fakeId("seed"), txOutIndex: 0, signature: "" }],
    txOuts: [{ address: receiver.address, amount: 10 }]
  };
  tx.id = getTxId(tx);
  tx.txIns[0].signature = signWith(owner.keyPair, tx.id);

  assert.strictEqual(validateTx(tx, uTxOuts), true);
});

test("서명이 깨진 tx 는 예외 대신 false 를 돌려준다", () => {
  const owner = makeWallet();
  const uTxOuts = [
    { txOutId: fakeId("seed"), txOutIndex: 0, address: owner.address, amount: 10 }
  ];
  const tx = {
    txIns: [{ txOutId: fakeId("seed"), txOutIndex: 0, signature: "not-a-signature" }],
    txOuts: [{ address: owner.address, amount: 10 }]
  };
  tx.id = getTxId(tx);

  assert.strictEqual(validateTx(tx, uTxOuts), false);
});

test("입력보다 많이 쓰는 tx 는 거부된다", () => {
  const owner = makeWallet();
  const uTxOuts = [
    { txOutId: fakeId("seed"), txOutIndex: 0, address: owner.address, amount: 10 }
  ];
  const tx = {
    txIns: [{ txOutId: fakeId("seed"), txOutIndex: 0, signature: "" }],
    txOuts: [{ address: owner.address, amount: 999 }] // 무에서 창조
  };
  tx.id = getTxId(tx);
  tx.txIns[0].signature = signWith(owner.keyPair, tx.id);

  assert.strictEqual(validateTx(tx, uTxOuts), false);
});

test("블록에 위조 tx 가 하나라도 섞이면 블록 전체가 거부된다", () => {
  // 수정 전: reduce((a,b) => a+b, true) 라 true+false === 1 (truthy) 로 통과했다.
  const miner = makeWallet();
  const victim = makeWallet();
  const attacker = makeWallet();

  const uTxOuts = [
    { txOutId: fakeId("seed"), txOutIndex: 0, address: victim.address, amount: 10 }
  ];

  const coinbaseTx = createCoinbaseTx(miner.address, 1);

  const forged = {
    txIns: [{ txOutId: fakeId("seed"), txOutIndex: 0, signature: "" }],
    txOuts: [{ address: attacker.address, amount: 10 }]
  };
  forged.id = getTxId(forged);
  forged.txIns[0].signature = signWith(attacker.keyPair, forged.id);

  assert.strictEqual(processTxs([coinbaseTx, forged], uTxOuts, 1), null);
});

test("코인베이스 발행량을 부풀린 블록은 거부된다", () => {
  // 수정 전: validateCoinbaseTx 가 false 여도 return 이 없어 그냥 흘러내렸다.
  const miner = makeWallet();
  const coinbaseTx = createCoinbaseTx(miner.address, 1);
  coinbaseTx.txOuts[0].amount = getBlockSubsidy(1) * 2;
  coinbaseTx.id = getTxId(coinbaseTx);

  assert.strictEqual(processTxs([coinbaseTx], [], 1), null);
});

test("정상 블록은 UTxOut 목록을 돌려준다", () => {
  const miner = makeWallet();
  const coinbaseTx = createCoinbaseTx(miner.address, 1);
  const result = processTxs([coinbaseTx], [], 1);

  assert.ok(Array.isArray(result));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].address, miner.address);
  assert.strictEqual(result[0].amount, getBlockSubsidy(1));
});

test("빈 블록은 거부된다", () => {
  assert.strictEqual(processTxs([], [], 1), null);
});

test("난이도는 너무 빠르면 올라가고 너무 느리면 내려간다", () => {
  // 기대 간격 = BLOCK_GENERATION_INTERVAL(10) * DIFFICULTY_ADJUSMENT_INTERVAL(10) = 100초
  // 10블록이 걸린 시간은 index-10 블록의 타임스탬프에서 끝 블록까지다.
  // 그래서 체인은 창 시작 블록 + 10블록 = 11개다.
  const chainWith = (elapsed, difficulty) => {
    const chain = [];
    for (let i = 0; i <= 10; i++) {
      chain.push({ index: i, difficulty, timestamp: 1000 + Math.round(elapsed * i / 10) });
    }
    const newest = chain[10];
    assert.strictEqual(newest.timestamp, 1000 + elapsed);
    return { newest, chain };
  };

  // 50초 미만 -> 난이도 상승
  let { newest, chain } = chainWith(10, 15);
  assert.strictEqual(calculateNewDifficulty(newest, chain), 16);

  // 200초 초과 -> 난이도 하락
  ({ newest, chain } = chainWith(500, 15));
  assert.strictEqual(calculateNewDifficulty(newest, chain), 14);

  // 기대 시간(100초)대로 채굴하면 유지되어야 한다.
  // 수정 전에는 timeExpected/2 비교라 여기서도 난이도가 계속 떨어졌다.
  ({ newest, chain } = chainWith(100, 15));
  assert.strictEqual(calculateNewDifficulty(newest, chain), 15);

  // 창은 정확히 10블록이다. index-10 블록만 빨라도(창 밖) 결과가 바뀌면 안 된다.
  ({ newest, chain } = chainWith(100, 15));
  chain.unshift({ index: -1, difficulty: 15, timestamp: 0 });
  assert.strictEqual(calculateNewDifficulty(newest, chain), 15);
});

test("메인넷은 블록 사이가 아무리 벌어져도 최소 난이도 블록을 받지 않는다", () => {
  // 테스트넷의 20배 규칙(test/testnet.test.js)은 메인넷에 없다.
  // 시간을 앞당겨 적은 채굴자가 난이도를 피할 수 있으므로.
  const chain = [
    { index: 0, difficulty: 15, timestamp: 1000 },
    { index: 1, difficulty: 15, timestamp: 1010 }
  ];
  assert.strictEqual(difficultyForNext(chain, 1010 + 201), 15);
  assert.strictEqual(difficultyForNext(chain, 1010 + 24 * 3600), 15);
  assert.strictEqual(difficultyForNext(chain), 15);
});

test("난이도는 1 아래로 내려가지 않는다", () => {
  // difficulty 0 이면 "0".repeat(0) === "" 라 어떤 해시든 통과해 버린다.
  const chain = [];
  for (let i = 0; i <= 10; i++) {
    chain.push({ index: i, difficulty: 1, timestamp: 1000 + i * 500 });
  }
  const newest = chain[10];
  assert.strictEqual(calculateNewDifficulty(newest, chain), 1);
});

test("replaceChain 은 잘못된 체인을 받아도 예외 없이 false 를 돌려준다", () => {
  // 수정 전: isChainValid 안의 candidateBlock 오타로 ReferenceError 가 났다.
  assert.strictEqual(replaceChain([]), false);
  assert.strictEqual(replaceChain([genesis]), false);
  assert.strictEqual(
    replaceChain([genesis, { index: 1, hash: "가짜", previousHash: "없음" }]),
    false
  );
  assert.strictEqual(replaceChain([{ index: 0, hash: "다른 제네시스" }]), false);
});

test("주소 형식 검증", () => {
  const { address } = makeWallet();
  assert.strictEqual(isAddressValid(address), true);
  assert.strictEqual(isAddressValid("04" + "z".repeat(128)), false); // 16진수 아님
  assert.strictEqual(isAddressValid("05" + "a".repeat(128)), false); // 04 로 시작 안 함
  assert.strictEqual(isAddressValid("04ab"), false);                 // 길이 부족
});

test("제네시스 파일에 개인키가 들어 있지 않다", () => {
  const raw = JSON.stringify(genesis);
  assert.ok(!raw.includes("privateKey"));
  assert.strictEqual(genesis.index, 0);
  assert.strictEqual(genesis.previousHash, "0".repeat(64), "제네시스 앞에는 아무것도 없다: 0 32바이트");
  assert.strictEqual(isAddressValid(genesis.data[0].txOuts[0].address), true);
  assert.strictEqual(getTxId(genesis.data[0]), genesis.data[0].id);
});
