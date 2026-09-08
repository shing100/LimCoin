/**
 * 코인 선택 — 어떤 출력들을 써서 금액을 채울 것인가.
 *
 * 예전에는 배열 순서대로 담다가 채워지면 멈췄다. 큰 출력을 잘게 쪼개
 * 잔돈을 남기기 일쑤였고, 그 잔돈이 쌓이면 다음 송금은 입력이 여러 개가 된다.
 */
const test = require("node:test");
const assert = require("node:assert");

const { findAmountInUTxOuts, findExactMatch, DUST } = require("../src/wallet");
const { COIN } = require("../src/units");

const u = (id, amount) => ({ txOutId: id, txOutIndex: 0, address: "a", amount });

test("하나로 되는 출력이 있으면 그중 가장 작은 것을 쓴다", () => {
  const pool = [u("big", 50 * COIN), u("mid", 10 * COIN), u("small", 3 * COIN)];
  const { includedUTxOuts, leftOverAmount } = findAmountInUTxOuts(4 * COIN, pool);

  assert.deepStrictEqual(includedUTxOuts.map(x => x.txOutId), ["mid"]);
  assert.strictEqual(leftOverAmount, 6 * COIN);
  // 예전 방식이면 배열 앞의 big(50) 을 쪼개 46 을 잔돈으로 남겼다
});

test("정확히 맞는 출력이 있으면 잔돈이 없다", () => {
  const pool = [u("a", 7 * COIN), u("b", 4 * COIN), u("c", 9 * COIN)];
  const { includedUTxOuts, leftOverAmount } = findAmountInUTxOuts(4 * COIN, pool);
  assert.deepStrictEqual(includedUTxOuts.map(x => x.txOutId), ["b"]);
  assert.strictEqual(leftOverAmount, 0);
});

test("하나로 안 되면 큰 것부터 담아 입력 수를 줄인다", () => {
  const pool = [u("d1", 1 * COIN), u("d2", 1 * COIN), u("d3", 1 * COIN), u("m", 5 * COIN), u("l", 6 * COIN)];
  const { includedUTxOuts, leftOverAmount } = findAmountInUTxOuts(10 * COIN, pool);

  // 6 + 5 = 11 >= 10. 두 개면 된다. 순서대로 담았다면 1+1+1+5+6 다섯 개였다.
  assert.deepStrictEqual(includedUTxOuts.map(x => x.txOutId), ["l", "m"]);
  assert.strictEqual(leftOverAmount, 1 * COIN);
});

test("모자라면 던진다", () => {
  assert.throws(() => findAmountInUTxOuts(10 * COIN, [u("a", 3 * COIN), u("b", 2 * COIN)]), /Not enough funds/);
  assert.throws(() => findAmountInUTxOuts(1, []), /Not enough funds/);
});

test("원본 배열을 건드리지 않는다", () => {
  const pool = [u("a", 1 * COIN), u("b", 5 * COIN), u("c", 3 * COIN)];
  const snapshot = pool.map(x => x.txOutId);
  findAmountInUTxOuts(6 * COIN, pool);
  assert.deepStrictEqual(pool.map(x => x.txOutId), snapshot, "정렬은 복사본에서 해야 한다");
});

/* ------------------------------------------- 잔돈 없는 조합 (Branch and Bound) */

test("정확히 채우는 조합이 있으면 그것을 써서 잔돈을 없앤다", () => {
  // 7 은 하나로 안 된다. 4 + 3 = 7 이 정확히 맞는다. 큰 것부터 담으면 5 + 4 = 9 (잔돈 2).
  const pool = [u("a", 5 * COIN), u("b", 4 * COIN), u("c", 3 * COIN)];
  const { includedUTxOuts, leftOverAmount } = findAmountInUTxOuts(7 * COIN, pool);

  assert.deepStrictEqual(includedUTxOuts.map(x => x.txOutId).sort(), ["b", "c"]);
  assert.strictEqual(leftOverAmount, 0);
});

test("하나로 되는 것이 있어도 정확한 조합이 우선이다", () => {
  const pool = [u("big", 10 * COIN), u("x", 2 * COIN), u("y", 1 * COIN)];
  const { includedUTxOuts, leftOverAmount } = findAmountInUTxOuts(3 * COIN, pool);
  assert.deepStrictEqual(includedUTxOuts.map(x => x.txOutId).sort(), ["x", "y"]);
  assert.strictEqual(leftOverAmount, 0);
});

test("dust 이내로 넘치는 조합도 정확한 것으로 친다", () => {
  const pool = [u("a", 5 * COIN), u("b", 3 * COIN + DUST - 1)];
  const { includedUTxOuts, leftOverAmount } = findAmountInUTxOuts(3 * COIN, pool);
  assert.deepStrictEqual(includedUTxOuts.map(x => x.txOutId), ["b"]);
  assert.strictEqual(leftOverAmount, DUST - 1, "이 잔돈은 출력이 되지 않고 수수료로 간다");
});

test("남은 것을 다 넣어도 모자라는 갈래는 접는다 — 시도 횟수 상한 안에서 끝난다", () => {
  // 서로 다른 값 60개, 어느 조합으로도 정확히 안 되는 목표
  const pool = Array.from({ length: 60 }, (_, i) => u(`u${i}`, (i + 1) * 1000 * COIN + 7));
  const started = Date.now();
  assert.strictEqual(findExactMatch(3, pool, 0), null);
  assert.ok(Date.now() - started < 2000, "탐색이 폭발하면 안 된다");
});

test("정확한 조합이 없으면 예전 규칙(하나 → 큰 것부터)으로 간다", () => {
  const pool = [u("a", 5 * COIN), u("b", 4 * COIN)];
  // 6: 정확히 안 됨, 하나로 안 됨 → 5 + 4
  const { includedUTxOuts, leftOverAmount } = findAmountInUTxOuts(6 * COIN, pool);
  assert.deepStrictEqual(includedUTxOuts.map(x => x.txOutId), ["a", "b"]);
  assert.strictEqual(leftOverAmount, 3 * COIN);
});
