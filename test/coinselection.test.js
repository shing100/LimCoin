/**
 * 코인 선택 — 어떤 출력들을 써서 금액을 채울 것인가.
 *
 * 예전에는 배열 순서대로 담다가 채워지면 멈췄다. 큰 출력을 잘게 쪼개
 * 잔돈을 남기기 일쑤였고, 그 잔돈이 쌓이면 다음 송금은 입력이 여러 개가 된다.
 */
const test = require("node:test");
const assert = require("node:assert");

const { findAmountInUTxOuts } = require("../src/wallet");
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
