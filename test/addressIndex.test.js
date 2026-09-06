/**
 * 주소 색인 되감기.
 *
 * 체인이 갈라지면 밀려난 블록의 기록도 함께 사라져야 한다.
 * 예전에는 그걸 위해 색인을 통째로 다시 만들었다.
 */
const test = require("node:test");
const assert = require("node:assert");

const AddressIndex = require("../src/addressIndex");

// 코인베이스 한 건만 든 블록
const coinbaseBlock = (index, address, amount) => ({
  index,
  timestamp: 1000 + index,
  data: [
    {
      id: `tx-${index}`,
      txIns: [{ txOutId: "", txOutIndex: index, signature: "" }],
      txOuts: [{ address, amount }]
    }
  ]
});

const heights = address =>
  AddressIndex.getTransactions(address, 100).transactions.map(e => e.blockIndex);

test("rollbackTo 는 그 높이부터의 기록만 걷어 낸다", () => {
  AddressIndex.reset();
  let uTxOuts = [];
  for (let i = 0; i < 5; i++) {
    const block = coinbaseBlock(i, "주소A", 10);
    AddressIndex.applyBlock(block, uTxOuts);
    uTxOuts = uTxOuts.concat(
      block.data.map(tx => ({
        txOutId: tx.id,
        txOutIndex: 0,
        address: tx.txOuts[0].address,
        amount: tx.txOuts[0].amount
      }))
    );
  }

  // 최신 것부터 돌려주므로 4,3,2,1,0
  assert.deepStrictEqual(heights("주소A"), [4, 3, 2, 1, 0]);

  AddressIndex.rollbackTo(3);
  assert.deepStrictEqual(heights("주소A"), [2, 1, 0]);

  AddressIndex.rollbackTo(0);
  assert.deepStrictEqual(heights("주소A"), []);
});

test("되감아서 기록이 하나도 남지 않으면 주소 자체가 사라진다", () => {
  AddressIndex.reset();
  AddressIndex.applyBlock(coinbaseBlock(7, "잠깐등장", 10), []);
  assert.strictEqual(AddressIndex.hasAddress("잠깐등장"), true);

  AddressIndex.rollbackTo(7);
  assert.strictEqual(AddressIndex.hasAddress("잠깐등장"), false);
  assert.strictEqual(AddressIndex.getIndexedAddressCount(), 0);
});

test("되감기는 남는 주소의 기록에는 손대지 않는다", () => {
  AddressIndex.reset();
  AddressIndex.applyBlock(coinbaseBlock(0, "오래된주소", 10), []);
  AddressIndex.applyBlock(coinbaseBlock(1, "새주소", 10), []);

  AddressIndex.rollbackTo(1);

  assert.deepStrictEqual(heights("오래된주소"), [0]);
  assert.strictEqual(AddressIndex.hasAddress("새주소"), false);
});
