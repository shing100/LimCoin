/**
 * 누적 일한 양 캐시.
 *
 * tipWork / workUpTo 는 높이별 누적값을 들고 있다가 뒤에 붙는 것만 이어서
 * 채운다. 매번 체인을 통째로 훑던 것을 대신하는데, 이 값을 묻는 자리가
 * 죄다 뜨거운 길목이라서 그렇다 — 새 블록을 알릴 때(P2P), /info 와
 * /metrics, getblock.
 *
 * 위험한 자리는 체인이 갈릴 때다. 갈라진 지점 뒤를 버리지 않으면 밀려난
 * 블록의 무게를 계속 들고 있게 되고, 노드는 그 값으로 "저쪽이 더 무거운가"를
 * 판단한다 — 옳은 체인을 거부하거나 틀린 체인을 받는다.
 *
 * **regtest 를 쓴다.** LWMA 창이 8이라 몇 블록만 지나면 간격에 따라 블록마다
 * 난이도가 달라진다. 난이도가 다 같으면 낡은 캐시 값이 우연히 맞아떨어져서
 * 이 테스트가 아무것도 못 잡는다 — 실제로 처음에 그랬다.
 */
process.env.LIMCOIN_NETWORK = "regtest";

const test = require("node:test");
const assert = require("node:assert");

const Blockchain = require("../src/blockchain");
const Target = require("../src/target");
const { getBlockChain, replaceChain, bitsForNext, tipWork, workUpTo, chainWork } = Blockchain;
const { coinbaseBlockOntoAt, newAddress } = require("./helpers");

const genesis = getBlockChain()[0];
const now = () => Math.round(Date.now() / 1000);

// chain 끝에 spacing 초 간격으로 count 개를 프로토콜이 요구하는 bits 로 붙인다
const extend = (chain, count, spacing, first) => {
  for (let i = 0; i < count; i++) {
    const tip = chain[chain.length - 1];
    const timestamp = i === 0 && first !== undefined ? first : tip.timestamp + spacing;
    chain.push(coinbaseBlockOntoAt(tip, newAddress(), timestamp, bitsForNext(chain, timestamp)));
  }
  return chain;
};

// 캐시 값 == 통째로 다시 센 값 (팁과 모든 높이에서)
const workAgrees = where => {
  const chain = getBlockChain();
  assert.strictEqual(tipWork(), chainWork(chain), `${where}: 팁 무게`);
  for (let h = 0; h < chain.length; h++) {
    assert.strictEqual(workUpTo(h), chainWork(chain.slice(0, h + 1)), `${where}: 높이 ${h}`);
  }
};

// 난이도가 실제로 흔들렸는지 — 안 흔들렸으면 이 테스트는 아무것도 못 잡는다
const difficultyVaries = chain => new Set(chain.map(block => block.bits)).size > 1;

let ours;

test("붙일 때마다 이어서 채워지고, 난이도가 달라도 맞는다", () => {
  workAgrees("제네시스만");

  ours = extend([genesis], 14, 10, now());
  assert.strictEqual(replaceChain(ours), true, "체인이 서야 한다");
  assert.ok(difficultyVaries(getBlockChain()), "난이도가 블록마다 달라야 이 테스트가 의미가 있다");
  workAgrees("14블록");

  // 하나씩 더 붙이며 — 캐시가 이어서 채워지는지
  for (let i = 0; i < 3; i++) {
    const chain = getBlockChain().slice();
    extend(chain, 1, 3); // 간격을 좁혀 난이도를 올린다
    assert.strictEqual(replaceChain(chain), true);
    workAgrees(`${15 + i}블록`);
  }
});

test("체인이 갈리면 갈라진 지점 뒤를 버린다", () => {
  const before = getBlockChain();
  const forkAt = 6;
  const atFork = workUpTo(forkAt);
  const beforeWork = tipWork();

  /*
   * 높이 6 뒤로 갈라진 더 무거운 체인. 간격을 훨씬 좁혀 난이도를 올리므로
   * 겹치는 높이(7..)의 블록별 무게가 원래 것과 다르다 — 캐시를 안 버리면
   * 그 자리에서 값이 어긋난다.
   */
  const rival = extend(before.slice(0, forkAt + 1).map(block => ({ ...block })), 12, 1);
  assert.strictEqual(replaceChain(rival), true, "더 무거운 체인이어야 한다");

  workAgrees("갈아 끼운 뒤");
  assert.strictEqual(workUpTo(forkAt), atFork, "공통 접두사의 무게는 그대로다");
  assert.ok(tipWork() > beforeWork, "갈아 끼운 체인이 더 무겁다");

  // 겹치는 높이의 무게가 실제로 달라졌는지 — 아니면 위 검사가 헛돈 것이다
  const after = getBlockChain();
  const overlap = Math.min(before.length, after.length) - 1;
  assert.ok(
    Target.workOf(before[overlap].bits) !== Target.workOf(after[overlap].bits),
    `높이 ${overlap} 의 무게가 그대로면 이 테스트는 낡은 캐시를 못 잡는다`
  );
});

test("버린 자리부터 다시 채워진다", () => {
  const chain = getBlockChain().slice();
  extend(chain, 2, 10);
  assert.strictEqual(replaceChain(chain), true);
  workAgrees("갈아 끼운 뒤 또 붙였을 때");
});

test("팁을 넘겨 물으면 팁까지만, 음수면 0", () => {
  const last = getBlockChain().length - 1;
  assert.strictEqual(workUpTo(last + 100), tipWork());
  assert.strictEqual(workUpTo(-1), 0n);
  assert.strictEqual(workUpTo(0), chainWork([genesis]));
});

test("무게는 높이가 아니라 난이도의 합이다", () => {
  const chain = getBlockChain();
  const sum = chain.reduce((total, block) => total + Target.workOf(block.bits), 0n);
  assert.strictEqual(tipWork(), sum);
  // 짧고 어려운 체인이 길고 쉬운 체인을 이길 수 있어야 한다
  const hardest = chain.reduce((a, b) => (Target.workOf(a.bits) > Target.workOf(b.bits) ? a : b));
  const easiest = chain.reduce((a, b) => (Target.workOf(a.bits) < Target.workOf(b.bits) ? a : b));
  assert.ok(Target.workOf(hardest.bits) > Target.workOf(easiest.bits));
});
