/**
 * regtest — LWMA 창이 8이라 몇 블록만 실제로 채굴해도 목표값 조정이 도는 것을 볼 수 있다.
 * (테스트넷 제네시스와 주소를 쓴다. 매직만 다르다.)
 */
process.env.LIMCOIN_NETWORK = "regtest";

const test = require("node:test");
const assert = require("node:assert");

const Params = require("../src/params");
const Target = require("../src/target");
const Blockchain = require("../src/blockchain");
const { bitsForNext, replaceChain, getBlockChain, isHeaderValid, headerOf } = Blockchain;
const { coinbaseBlockOntoAt, newAddress } = require("./helpers");

const N = Params.current().lwmaWindow;
const genesis = getBlockChain()[0];

// chain 끝에 정확히 spacing 초 간격으로 count 개를 프로토콜이 요구하는 bits 로 채굴해 붙인다.
// (채굴에 시간이 걸려도 타임스탬프는 시계가 아니라 직전 블록 기준이라 간격이 흔들리지 않는다)
const extend = (chain, count, spacing, first) => {
  for (let i = 0; i < count; i++) {
    const tip = chain[chain.length - 1];
    const timestamp = i === 0 && first !== undefined ? first : tip.timestamp + spacing;
    const bits = bitsForNext(chain, timestamp);
    chain.push(coinbaseBlockOntoAt(tip, newAddress(), timestamp, bits));
  }
  return chain;
};

const now = () => Math.round(Date.now() / 1000);

test("regtest 는 창이 8이고 테스트넷 제네시스를 쓴다", () => {
  assert.strictEqual(N, 8);
  assert.strictEqual(Params.current().magic, "limcoin/regtest/1");
  assert.strictEqual(genesis.hash, require("../src/genesis.testnet.json").hash);
});

test("실제로 채굴한 체인: 10초 간격이면 목표값이 유지되고, 빨라지면 어려워지고, 검증을 통과한다", () => {
  // 첫 블록은 제네시스(과거) 뒤 200초가 지나 특별 블록(바닥 bits)이다
  let chain = extend([genesis], 1, 10, now());
  assert.strictEqual(chain[1].bits, Target.POW_LIMIT_BITS);

  // 그 뒤 N+2 블록을 10초 간격으로 — 창이 차고 나서도 목표값은 제네시스 값 그대로다
  chain = extend(chain, N + 2, 10);
  const steady = chain[chain.length - 1];
  assert.ok(steady.index > N, "창이 찼다");
  assert.strictEqual(steady.bits, genesis.bits, "특별 블록은 중립이고 나머지는 정속이다");

  // 1초 간격으로 두 블록 — 목표값이 줄어야 한다(어려워진다)
  chain = extend(chain, 2, 1);
  const fast = chain[chain.length - 1];
  assert.ok(
    Target.targetFromBits(fast.bits) < Target.targetFromBits(genesis.bits),
    `빨라졌으니 어려워야 한다: ${fast.bits.toString(16)}`
  );
  assert.ok(Target.difficultyOf(fast.bits) > Target.difficultyOf(genesis.bits));

  // 이 체인은 프로토콜이 정한 bits 로만 채굴했으므로 그대로 받아들여진다
  assert.strictEqual(replaceChain(chain), true);
  assert.strictEqual(getBlockChain().length, chain.length);

  // 같은 자리에 옛(제네시스) bits 로 채굴한 블록은 거부된다
  const tip = chain[chain.length - 1];
  const stale = coinbaseBlockOntoAt(tip, newAddress(), tip.timestamp + 1, genesis.bits);
  assert.strictEqual(isHeaderValid(headerOf(stale), chain), false);
  const right = coinbaseBlockOntoAt(tip, newAddress(), tip.timestamp + 1, bitsForNext(chain, tip.timestamp + 1));
  assert.strictEqual(isHeaderValid(headerOf(right), chain), true);
});
