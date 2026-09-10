/**
 * 차트·부자 목록이 쓰는 집계.
 *
 * 익스플로러가 이걸 프론트에서 계산하려면 블록 본문을 전부 받아야 한다
 * (2000블록이면 수백 MB). 노드는 헤더만 보고 만들 수 있으므로 노드가 만든다.
 *
 * **regtest 를 쓴다.** LWMA 창이 8이라 몇 블록만 지나도 간격에 따라 난이도가
 * 달라진다. 난이도가 다 같으면 "난이도를 제대로 읽어 오는가"를 확인할 수 없다.
 */
process.env.LIMCOIN_NETWORK = "regtest";

const test = require("node:test");
const assert = require("node:assert");

const Blockchain = require("../src/blockchain");
const Target = require("../src/target");
const {
  getBlockChain, replaceChain, bitsForNext, getRichList, getBlockSeries,
  getBlockByHeight, getUTxOutList
} = Blockchain;
const { coinbaseBlockOntoAt, newAddress } = require("./helpers");

const genesis = getBlockChain()[0];
const now = () => Math.round(Date.now() / 1000);

/*
 * 주소 세 개에 돌아가며 채굴한다. 한 주소에만 캐면 순위가 한 줄뿐이라
 * "정렬이 되는가"도 "주소별로 합치는가"도 확인할 수 없다.
 */
const ADDRESSES = [newAddress(), newAddress(), newAddress()];

const build = (count, spacings) => {
  const chain = [genesis];
  let stamp = now() - count * 12;
  for (let i = 0; i < count; i++) {
    const tip = chain[chain.length - 1];
    stamp = tip.timestamp + spacings[i % spacings.length];
    chain.push(
      coinbaseBlockOntoAt(tip, ADDRESSES[i % ADDRESSES.length], stamp, bitsForNext(chain, stamp))
    );
  }
  return chain;
};

test("블록 시계열은 높이·간격·난이도·트랜잭션 수를 준다", () => {
  const chain = build(20, [4, 9, 15, 6, 20]);
  assert.strictEqual(replaceChain(chain), true, "체인이 서야 한다");

  const all = getBlockSeries(1000);
  assert.strictEqual(all.length, 21, "체인보다 많이 달라고 해도 있는 만큼만");
  assert.strictEqual(all[0].height, 0);
  assert.strictEqual(all[0].solveTime, null, "제네시스는 앞 블록이 없다");

  for (let i = 1; i < all.length; i++) {
    assert.strictEqual(all[i].height, i);
    assert.strictEqual(
      all[i].solveTime,
      chain[i].timestamp - chain[i - 1].timestamp,
      `높이 ${i} 의 간격`
    );
    assert.strictEqual(all[i].difficulty, Target.difficultyOf(chain[i].bits));
    assert.strictEqual(all[i].txCount, 1, "코인베이스 한 건");
  }

  // 난이도가 실제로 흔들려야 이 확인이 의미가 있다
  assert.ok(new Set(all.map(r => r.bits)).size > 1, "난이도가 블록마다 달라야 한다");
});

test("창을 잘라 달라고 해도 첫 줄의 간격을 잃지 않는다", () => {
  const chain = getBlockChain();
  const window = getBlockSeries(5);

  assert.strictEqual(window.length, 5);
  assert.strictEqual(window[window.length - 1].height, chain.length - 1, "최신이 마지막");

  /*
   * 창의 첫 줄은 창 밖의 앞 블록과 견줘야 한다. 예전 구현처럼 잘라 낸
   * 배열 안에서만 앞을 찾으면 이 줄이 null 이 되고, 차트 왼쪽 끝이 늘 비었다.
   */
  const first = window[0];
  assert.strictEqual(
    first.solveTime,
    chain[first.height].timestamp - chain[first.height - 1].timestamp,
    "창 밖의 앞 블록과 견준다"
  );
});

test("부자 목록은 주소별로 합쳐 많은 순으로 준다", () => {
  const { total, rows } = getRichList(100);

  assert.strictEqual(total, rows.length);
  assert.ok(total > 1, "주소가 여럿이어야 순위가 의미가 있다");

  // 내림차순
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].balance >= rows[i].balance, "잔액 내림차순");
  }

  // 합계가 UTXO 전체와 같아야 한다 — 빠뜨린 주소가 없다는 뜻
  const utxos = getUTxOutList();
  const expected = utxos.reduce((sum, u) => sum + u.amount, 0);
  assert.strictEqual(rows.reduce((sum, r) => sum + r.balance, 0), expected);

  // 주소마다 출력 개수도 맞아야 한다
  rows.forEach(row => {
    const mine = utxos.filter(u => u.address === row.address);
    assert.strictEqual(row.outputs, mine.length, `${row.address} 의 출력 개수`);
    assert.strictEqual(row.balance, mine.reduce((sum, u) => sum + u.amount, 0));
  });
});

test("limit 은 자르기만 하고 total 은 전체를 말한다", () => {
  const all = getRichList(100);
  const two = getRichList(2);

  assert.strictEqual(two.rows.length, 2);
  assert.strictEqual(two.total, all.total, "total 은 자르기 전 개수");
  assert.deepStrictEqual(two.rows, all.rows.slice(0, 2));
});

test("블록이 붙으면 부자 목록도 따라 바뀐다", () => {
  /*
   * 여기가 이 파일에서 가장 잘 틀리는 자리다. 목록은 팁 해시를 열쇠로
   * 캐시해 두는데, 열쇠를 잘못 잡으면 새 블록이 나와도 옛 잔액을 계속
   * 보여 준다. 화면은 멀쩡해 보이므로 아무도 알아채지 못한다.
   */
  const before = getRichList(100);
  const target = ADDRESSES[0];
  const beforeMine = before.rows.find(r => r.address === target);

  const chain = getBlockChain().slice();
  const tip = chain[chain.length - 1];
  const stamp = tip.timestamp + 7;
  chain.push(coinbaseBlockOntoAt(tip, target, stamp, bitsForNext(chain, stamp)));
  assert.strictEqual(replaceChain(chain), true);

  const after = getRichList(100);
  const afterMine = after.rows.find(r => r.address === target);

  assert.ok(afterMine.balance > beforeMine.balance, "새로 캔 보상이 반영돼야 한다");
  assert.strictEqual(afterMine.outputs, beforeMine.outputs + 1);
});

test("높이로 블록 하나를 바로 집는다", () => {
  const chain = getBlockChain();

  assert.strictEqual(getBlockByHeight(0).hash, chain[0].hash);
  assert.strictEqual(getBlockByHeight(3).index, 3);
  assert.strictEqual(getBlockByHeight(chain.length - 1).hash, chain[chain.length - 1].hash);

  // 범위 밖
  assert.strictEqual(getBlockByHeight(chain.length), undefined);
  assert.strictEqual(getBlockByHeight(undefined), undefined);
});
