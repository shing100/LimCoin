/**
 * 테스트넷 규칙 — 다른 파일과 달리 LIMCOIN_NETWORK=testnet 으로 모듈을 올린다.
 * (node:test 는 파일마다 프로세스를 따로 띄우므로 여기서 정한 환경은
 * 다른 테스트에 새지 않는다.)
 */
process.env.LIMCOIN_NETWORK = "testnet";

const test = require("node:test");
const assert = require("node:assert");

const Params = require("../src/params");
const Address = require("../src/address");
const {
  difficultyForNext,
  lastRealDifficulty,
  isHeaderValid,
  headerOf,
  getBlockChain,
  MIN_DIFFICULTY,
  BlOCK_GENERATION_INTERVAL
} = require("../src/blockchain");
const { coinbaseBlockOnto } = require("./helpers");

const GAP = BlOCK_GENERATION_INTERVAL * 20; // 200초

test("테스트넷은 제네시스, 주소 버전, 매직이 메인넷과 다르다", () => {
  const params = Params.current();
  assert.strictEqual(params.name, "testnet");
  assert.strictEqual(params.addressVersion, 0x6f);
  assert.strictEqual(params.magic, "limcoin/test/1");
  assert.strictEqual(params.allowMinDifficultyBlocks, true);
  assert.strictEqual(Params.NETWORKS.mainnet.allowMinDifficultyBlocks, false);

  const genesis = getBlockChain()[0];
  assert.strictEqual(genesis.hash, require("../src/genesis.testnet.json").hash);
  assert.notStrictEqual(genesis.hash, require("../src/genesis.json").hash);
  // 테스트넷 제네시스의 코인베이스 주소는 m/n 으로 시작한다
  const address = genesis.data[0].txOuts[0].address;
  assert.match(address, /^[mn]/);
  assert.strictEqual(Address.isAddressValid(address, 0x6f), true);
  assert.strictEqual(Address.isAddressValid(address, 0x30), false);
});

test("직전 블록 뒤로 200초가 넘게 지났으면 기대 난이도는 최소 난이도다", () => {
  const chain = [
    { index: 0, difficulty: 15, timestamp: 1000 },
    { index: 1, difficulty: 15, timestamp: 1010 }
  ];
  // 정확히 200초는 아니다 — 초과여야 한다
  assert.strictEqual(difficultyForNext(chain, 1010 + GAP), 15);
  assert.strictEqual(difficultyForNext(chain, 1010 + GAP + 1), MIN_DIFFICULTY);
  // 타임스탬프를 모르면(채굴 전 조회) 규칙을 적용하지 않는다
  assert.strictEqual(difficultyForNext(chain), 15);
});

test("특별 블록 다음 블록은 원래 난이도로 돌아간다 (난이도를 이어받지 않는다)", () => {
  const chain = [
    { index: 0, difficulty: 15, timestamp: 1000 },
    { index: 1, difficulty: 15, timestamp: 1010 },
    { index: 2, difficulty: MIN_DIFFICULTY, timestamp: 1010 + GAP + 1 }
  ];
  assert.strictEqual(lastRealDifficulty(chain), 15);
  assert.strictEqual(difficultyForNext(chain, chain[2].timestamp + 10), 15);

  // 특별 블록이 연달아 있어도 그 앞의 진짜 난이도까지 되짚는다
  const more = chain.concat([
    { index: 3, difficulty: MIN_DIFFICULTY, timestamp: chain[2].timestamp + GAP + 1 },
    { index: 4, difficulty: MIN_DIFFICULTY, timestamp: chain[2].timestamp + 2 * GAP + 2 }
  ]);
  assert.strictEqual(lastRealDifficulty(more), 15);
  assert.strictEqual(difficultyForNext(more, more[4].timestamp + 10), 15);
});

test("조정 높이의 계산도 특별 블록을 건너뛴 난이도를 기준으로 한다", () => {
  // index 0..10, 그중 5, 7 이 특별 블록. 10블록이 정확히 100초 걸렸으니 유지되어야 한다.
  const chain = [];
  for (let i = 0; i <= 10; i++) {
    chain.push({
      index: i,
      difficulty: i === 5 || i === 7 ? MIN_DIFFICULTY : 15,
      timestamp: 1000 + i * 10
    });
  }
  assert.strictEqual(difficultyForNext(chain, chain[10].timestamp + 10), 15);
});

test("실제 블록: 200초 넘게 비었으면 최소 난이도 블록은 받고 원래 난이도 블록은 거부한다", () => {
  const genesis = getBlockChain()[0];
  // 제네시스 타임스탬프는 과거이므로 지금 채굴하는 블록은 200초 규칙에 걸린다
  assert.ok(Math.round(Date.now() / 1000) > genesis.timestamp + GAP);

  const special = coinbaseBlockOnto(genesis, undefined, 0, MIN_DIFFICULTY);
  assert.strictEqual(isHeaderValid(headerOf(special), [genesis]), true);

  // 같은 자리에 "진짜" 난이도로 채굴한 블록은 기대 난이도(1)와 달라 거부된다
  // — 난이도는 그 높이의 기대값과 같아야 한다(더 높아도 안 된다)
  const real = coinbaseBlockOnto(genesis, undefined, 0, genesis.difficulty);
  assert.strictEqual(isHeaderValid(headerOf(real), [genesis]), false);

  // 특별 블록 뒤 10초 뒤의 블록은 제네시스 난이도여야 한다
  const next = { ...special, timestamp: special.timestamp + 10 };
  assert.strictEqual(difficultyForNext([genesis, special], next.timestamp), genesis.difficulty);
});
