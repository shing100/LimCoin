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
const Target = require("../src/target");
const {
  bitsForNext,
  isHeaderValid,
  headerOf,
  getBlockChain,
  BlOCK_GENERATION_INTERVAL
} = require("../src/blockchain");
const { coinbaseBlockOnto } = require("./helpers");

const GAP = BlOCK_GENERATION_INTERVAL * 20; // 200초
const GENESIS_BITS = getBlockChain()[0].bits;
const N = Params.current().lwmaWindow;
const MIN = Target.POW_LIMIT_BITS;

const syntheticChain = (count, spacing) => {
  const chain = [];
  for (let i = 0; i < count; i++) {
    chain.push({ index: i, timestamp: 1000 + i * spacing, bits: GENESIS_BITS });
  }
  return chain;
};

test("테스트넷은 제네시스, 주소 버전, 매직이 메인넷과 다르다", () => {
  const params = Params.current();
  assert.strictEqual(params.name, "testnet");
  assert.strictEqual(params.addressVersion, 0x6f);
  assert.strictEqual(params.magic, "limcoin/test/1");
  assert.strictEqual(params.allowMinDifficultyBlocks, true);
  assert.strictEqual(Params.NETWORKS.mainnet.allowMinDifficultyBlocks, false);
  assert.strictEqual(Params.NETWORKS.regtest.magic, "limcoin/regtest/1");

  const genesis = getBlockChain()[0];
  assert.strictEqual(genesis.hash, require("../src/genesis.testnet.json").hash);
  assert.notStrictEqual(genesis.hash, require("../src/genesis.json").hash);
  // 테스트넷 제네시스의 코인베이스 주소는 m/n 으로 시작한다
  const address = genesis.data[0].txOuts[0].address;
  assert.match(address, /^[mn]/);
  assert.strictEqual(Address.isAddressValid(address, 0x6f), true);
  assert.strictEqual(Address.isAddressValid(address, 0x30), false);
});

test("직전 블록 뒤로 200초가 넘게 지났으면 기대 목표값은 바닥(최소 난이도)이다", () => {
  const chain = syntheticChain(2, 10);
  // 정확히 200초는 아니다 — 초과여야 한다
  assert.strictEqual(bitsForNext(chain, 1010 + GAP), GENESIS_BITS);
  assert.strictEqual(bitsForNext(chain, 1010 + GAP + 1), MIN);
  // 타임스탬프를 모르면(채굴 전 조회) 규칙을 적용하지 않는다
  assert.strictEqual(bitsForNext(chain), GENESIS_BITS);
});

test("특별 블록 다음 블록은 원래 목표값으로 돌아간다 (조정 전 구간)", () => {
  const chain = syntheticChain(2, 10);
  chain.push({ index: 2, timestamp: 1010 + GAP + 1, bits: MIN });
  assert.strictEqual(bitsForNext(chain, chain[2].timestamp + 10), GENESIS_BITS);
});

test("LWMA 창 안의 특별 블록은 중립으로 취급되어 난이도를 무너뜨리지 않는다", () => {
  // 정속(10초) 체인과, 같은 체인에서 블록 하나가 특별 블록(200초 뒤, 바닥 bits)인 것을 비교한다.
  const steady = syntheticChain(N + 1, 10);
  const withSpecial = syntheticChain(N + 1, 10);
  const at = N - 5;
  withSpecial[at].bits = MIN;
  // 특별 블록 뒤의 타임스탬프를 모두 GAP+1 만큼 밀어 "200초 뒤" 를 만든다
  for (let i = at; i <= N; i++) withSpecial[i].timestamp += GAP + 1;
  assert.strictEqual(bitsForNext(withSpecial), bitsForNext(steady));
  assert.strictEqual(bitsForNext(steady), GENESIS_BITS);
});

test("실제 블록: 200초 넘게 비었으면 바닥 목표값 블록은 받고 원래 목표값 블록은 거부한다", () => {
  const genesis = getBlockChain()[0];
  // 제네시스 타임스탬프는 과거이므로 지금 채굴하는 블록은 200초 규칙에 걸린다
  assert.ok(Math.round(Date.now() / 1000) > genesis.timestamp + GAP);

  const special = coinbaseBlockOnto(genesis, undefined, 0, MIN);
  assert.strictEqual(isHeaderValid(headerOf(special), [genesis]), true);

  // 같은 자리에 "진짜" 목표값으로 채굴한 블록은 기대값(바닥)과 달라 거부된다
  // — bits 는 그 높이의 기대값과 같아야 한다(더 어려워도 안 된다)
  const real = coinbaseBlockOnto(genesis, undefined, 0, genesis.bits);
  assert.strictEqual(isHeaderValid(headerOf(real), [genesis]), false);

  // 특별 블록 뒤 10초 뒤의 블록은 제네시스 목표값이어야 한다
  assert.strictEqual(bitsForNext([genesis, special], special.timestamp + 10), genesis.bits);
});
