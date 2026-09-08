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
const { bitsForNext, replaceChain, getBlockChain } = require("../src/blockchain");
const Target = require("../src/target");
const Params = require("../src/params");
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

/* ------------------------------------------- 목표값 (LWMA) */

const GENESIS_BITS = getBlockChain()[0].bits;
const N = Params.current().lwmaWindow;

// index 0..count-1, 간격 spacing 초, 모두 같은 bits 인 가짜 체인
const syntheticChain = (count, spacing, bits = GENESIS_BITS) => {
  const chain = [];
  for (let i = 0; i < count; i++) {
    chain.push({ index: i, timestamp: 1000 + i * spacing, bits });
  }
  return chain;
};

test("처음 lwmaWindow 블록은 제네시스의 목표값을 그대로 쓴다", () => {
  assert.strictEqual(bitsForNext(syntheticChain(1, 10)), GENESIS_BITS);
  assert.strictEqual(bitsForNext(syntheticChain(N, 1)), GENESIS_BITS, "아무리 빨라도 조정 전이다");
  assert.strictEqual(bitsForNext(syntheticChain(N, 1000)), GENESIS_BITS);
});

test("목표 간격(10초)대로 나오면 목표값이 유지된다", () => {
  assert.strictEqual(bitsForNext(syntheticChain(N + 1, 10)), GENESIS_BITS);
  assert.strictEqual(bitsForNext(syntheticChain(N + 40, 10)), GENESIS_BITS);
});

test("블록이 너무 빨리 나오면 목표값이 줄고(어려워지고), 느리면 늘어난다", () => {
  const fast = bitsForNext(syntheticChain(N + 1, 1));
  const slow = bitsForNext(syntheticChain(N + 1, 30));
  assert.ok(Target.targetFromBits(fast) < Target.targetFromBits(GENESIS_BITS));
  assert.ok(Target.targetFromBits(slow) > Target.targetFromBits(GENESIS_BITS));
  // 1초마다 나왔으면 10배 어려워져야 맞다(LWMA 는 비율로 고친다)
  const ratio = Target.difficultyOf(fast) / Target.difficultyOf(GENESIS_BITS);
  assert.ok(ratio > 9.5 && ratio < 10.5, `10배여야 한다: ${ratio}`);
});

test("풀이 시간은 [1, 6T] 로 잘린다 — 한 시간 비어도 60초로 친다", () => {
  const hour = bitsForNext(syntheticChain(N + 1, 3600));
  const minute = bitsForNext(syntheticChain(N + 1, 60));
  assert.strictEqual(hour, minute);
  // 시간을 앞당겨 적어 풀이 시간을 음수로 만들면 1초로 친다 — 난이도가 올라가는 쪽(공격자 손해)
  const backwards = syntheticChain(N + 1, 10);
  backwards[N].timestamp = backwards[N - 1].timestamp - 500;
  const oneSecond = syntheticChain(N + 1, 10);
  oneSecond[N].timestamp = oneSecond[N - 1].timestamp + 1;
  assert.strictEqual(bitsForNext(backwards), bitsForNext(oneSecond));
});

test("목표값은 바닥(POW_LIMIT)을 넘지 못한다", () => {
  const easy = bitsForNext(syntheticChain(N + 1, 60, Target.POW_LIMIT_BITS));
  assert.strictEqual(easy, Target.POW_LIMIT_BITS);
});

test("최근 블록에 더 큰 가중치를 준다", () => {
  // 같은 블록들이라도 느린 블록이 창의 끝에 있을 때 목표값이 더 많이 늘어난다
  const slowLast = syntheticChain(N + 1, 10);
  for (let i = 1; i <= N; i++) slowLast[i].timestamp = slowLast[i - 1].timestamp + (i === N ? 60 : 10);
  const slowFirst = syntheticChain(N + 1, 10);
  for (let i = 1; i <= N; i++) slowFirst[i].timestamp = slowFirst[i - 1].timestamp + (i === 1 ? 60 : 10);
  assert.ok(Target.targetFromBits(bitsForNext(slowLast)) > Target.targetFromBits(bitsForNext(slowFirst)));
});

test("메인넷은 블록 사이가 아무리 벌어져도 최소 난이도 블록을 받지 않는다", () => {
  // 테스트넷의 20배 규칙(test/testnet.test.js)은 메인넷에 없다.
  // 시간을 앞당겨 적은 채굴자가 난이도를 피할 수 있으므로.
  const chain = syntheticChain(2, 10);
  assert.strictEqual(bitsForNext(chain, 1010 + 201), GENESIS_BITS);
  assert.strictEqual(bitsForNext(chain, 1010 + 24 * 3600), GENESIS_BITS);
});

test("bits 압축 표기는 비트코인과 같다", () => {
  // 비트코인 제네시스 nBits 0x1d00ffff -> target 0x00000000ffff0000...0000
  assert.strictEqual(
    Target.targetHex(0x1d00ffff),
    "00000000ffff0000000000000000000000000000000000000000000000000000"
  );
  assert.strictEqual(Target.bitsFromTarget(Target.targetFromBits(0x1d00ffff)), 0x1d00ffff);
  // 가수 첫 비트가 1이면 한 바이트 밀어 표기한다 (0x00800000 은 음수 표시)
  assert.strictEqual(Target.bitsFromTarget(0x800000n), 0x04008000);
  assert.strictEqual(Target.targetFromBits(0x04008000), 0x800000n);
  // 음수 비트, 가수 0, 바닥보다 쉬운 값은 유효하지 않다
  assert.strictEqual(Target.isValidBits(0x03800001), false);
  assert.strictEqual(Target.isValidBits(0x1d000000), false);
  assert.strictEqual(Target.isValidBits(0x20ffffff), false);
  assert.strictEqual(Target.isValidBits(Target.POW_LIMIT_BITS), true);
  // 무게 = 2^256 / (target+1). 제네시스 목표값(≈2^241)은 평균 2^15 번
  assert.strictEqual(Target.workOf(GENESIS_BITS), 32768n);
  assert.ok(Math.abs(Target.difficultyOf(GENESIS_BITS) - 16384) < 1);
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
