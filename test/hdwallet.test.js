/**
 * HD 지갑과 주소 색인 테스트.
 *
 * 백서 10장 "Privacy":
 *   "a new key pair should be used for each transaction to keep them from
 *    being linked to a common owner"
 */
const test = require("node:test");
const assert = require("node:assert");

const HD = require("../src/hdwallet");
const AddressIndex = require("../src/addressIndex");
const { isAddressValid } = require("../src/transactions");
const { COIN } = require("../src/units");

/* --------------------------------------------- BIP32 공식 테스트 벡터 */

test("BIP32 테스트 벡터 1 — 마스터 키", () => {
  // https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
  const master = HD.masterFromSeed("000102030405060708090a0b0c0d0e0f");
  assert.strictEqual(
    master.key.toString(16).padStart(64, "0"),
    "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35"
  );
  assert.strictEqual(
    master.chainCode.toString("hex"),
    "873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508"
  );
});

test("BIP32 테스트 벡터 2 — m/0 자식 파생", () => {
  const seed =
    "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a2" +
    "9f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542";
  const child = HD.deriveChild(HD.masterFromSeed(seed), 0);
  assert.strictEqual(
    child.key.toString(16).padStart(64, "0"),
    "abe74a98f6c7eabee0428f53798f0ab8aa1bd37873999041703c742f15ac7e1e"
  );
  assert.strictEqual(
    child.chainCode.toString("hex"),
    "f0909affaa7ee7abe5dd4e100598d4dc53cd709d5a5c2cac40e7412f232f7c9c"
  );
});

/* ------------------------------------------------------- 파생 성질 */

test("같은 씨앗은 같은 키를, 다른 씨앗은 다른 키를 낸다", () => {
  const seed = HD.generateSeed();
  const other = HD.generateSeed();

  assert.strictEqual(
    HD.derivePrivateKey(seed, HD.RECEIVE, 0),
    HD.derivePrivateKey(seed, HD.RECEIVE, 0)
  );
  assert.notStrictEqual(
    HD.derivePrivateKey(seed, HD.RECEIVE, 0),
    HD.derivePrivateKey(other, HD.RECEIVE, 0)
  );
});

test("받는 갈래와 거스름돈 갈래는 서로 다른 키를 낸다", () => {
  // 같은 index 라도 갈래가 다르면 다른 주소여야 한다.
  // 섞이면 남에게 알려 준 주소로 거스름돈이 돌아온다.
  const seed = HD.generateSeed();
  for (const index of [0, 1, 5]) {
    assert.notStrictEqual(
      HD.derivePrivateKey(seed, HD.RECEIVE, index),
      HD.derivePrivateKey(seed, HD.CHANGE, index)
    );
  }
});

test("파생된 주소들은 서로 다르고 모두 형식이 유효하다", () => {
  const seed = HD.generateSeed();
  const addresses = new Set();
  for (const branch of [HD.RECEIVE, HD.CHANGE]) {
    for (let i = 0; i < 50; i++) {
      const address = HD.getPublicKey(HD.derivePrivateKey(seed, branch, i));
      assert.strictEqual(isAddressValid(address), true);
      addresses.add(address);
    }
  }
  assert.strictEqual(addresses.size, 100, "100개가 모두 달라야 한다");
});

test("씨앗만 있으면 주소를 전부 되살릴 수 있다", () => {
  // 백업할 것이 씨앗 하나뿐이라는 것이 HD 지갑의 요점이다.
  const seed = HD.generateSeed();
  const before = Array.from({ length: 10 }, (_, i) =>
    HD.getPublicKey(HD.derivePrivateKey(seed, HD.RECEIVE, i))
  );
  // 다른 시점에 같은 씨앗으로 다시 만든다
  const after = Array.from({ length: 10 }, (_, i) =>
    HD.getPublicKey(HD.derivePrivateKey(seed, HD.RECEIVE, i))
  );
  assert.deepStrictEqual(after, before);
});

/* ------------------------------------------------------- 주소 색인 */

const addr = n => "04" + String(n).repeat(2).padEnd(128, "0");

const blockWith = (index, txs) => ({
  index,
  timestamp: 1000 + index,
  data: txs
});

test("주소 색인은 받은 금액과 보낸 금액을 갈라 기록한다", () => {
  AddressIndex.reset();
  const alice = addr(1);
  const bob = addr(2);

  // 블록 0: 앨리스가 10 을 받는다 (코인베이스)
  const coinbase = {
    id: "cb0",
    txIns: [{ txOutId: "", txOutIndex: 0, signature: "" }],
    txOuts: [{ address: alice, amount: 10 * COIN }]
  };
  AddressIndex.applyBlock(blockWith(0, [coinbase]), []);

  // 블록 1: 앨리스가 밥에게 3 을 보내고 6.9 를 거슬러 받는다 (수수료 0.1)
  const uTxOutsBefore = [
    { txOutId: "cb0", txOutIndex: 0, address: alice, amount: 10 * COIN }
  ];
  const spend = {
    id: "tx1",
    txIns: [{ txOutId: "cb0", txOutIndex: 0, signature: "sig" }],
    txOuts: [
      { address: bob, amount: 3 * COIN },
      { address: alice, amount: 690000000 }
    ]
  };
  AddressIndex.applyBlock(blockWith(1, [spend]), uTxOutsBefore);

  const aliceTxs = AddressIndex.getTransactions(alice);
  assert.strictEqual(aliceTxs.total, 2);
  // 최신 것이 앞에 온다
  assert.strictEqual(aliceTxs.transactions[0].txId, "tx1");
  assert.strictEqual(aliceTxs.transactions[0].spent, 10 * COIN);
  assert.strictEqual(aliceTxs.transactions[0].received, 690000000);
  assert.strictEqual(aliceTxs.transactions[1].txId, "cb0");
  assert.strictEqual(aliceTxs.transactions[1].spent, 0);

  const bobTxs = AddressIndex.getTransactions(bob);
  assert.strictEqual(bobTxs.total, 1);
  assert.strictEqual(bobTxs.transactions[0].received, 3 * COIN);
  assert.strictEqual(bobTxs.transactions[0].spent, 0);
});

test("같은 블록 안에서 만들어진 출력을 뒤 트랜잭션이 써도 되짚는다", () => {
  AddressIndex.reset();
  const alice = addr(3);
  const bob = addr(4);

  const first = {
    id: "t1",
    txIns: [{ txOutId: "", txOutIndex: 0, signature: "" }],
    txOuts: [{ address: alice, amount: 5 * COIN }]
  };
  // 같은 블록에서 앨리스가 방금 받은 것을 바로 쓴다
  const second = {
    id: "t2",
    txIns: [{ txOutId: "t1", txOutIndex: 0, signature: "sig" }],
    txOuts: [{ address: bob, amount: 5 * COIN }]
  };
  AddressIndex.applyBlock(blockWith(0, [first, second]), []);

  const aliceTxs = AddressIndex.getTransactions(alice);
  assert.strictEqual(aliceTxs.total, 2);
  const spendEntry = aliceTxs.transactions.find(t => t.txId === "t2");
  assert.strictEqual(spendEntry.spent, 5 * COIN, "같은 블록 안 출력도 되짚어야 한다");
});

test("주소 색인 페이지네이션", () => {
  AddressIndex.reset();
  const alice = addr(5);
  for (let i = 0; i < 12; i++) {
    AddressIndex.applyBlock(
      blockWith(i, [
        {
          id: `t${i}`,
          txIns: [{ txOutId: "", txOutIndex: 0, signature: "" }],
          txOuts: [{ address: alice, amount: COIN }]
        }
      ]),
      []
    );
  }
  const page = AddressIndex.getTransactions(alice, 5, 0);
  assert.strictEqual(page.total, 12);
  assert.strictEqual(page.transactions.length, 5);
  assert.strictEqual(page.transactions[0].txId, "t11", "최신 것이 먼저");

  const second = AddressIndex.getTransactions(alice, 5, 5);
  assert.strictEqual(second.transactions[0].txId, "t6");

  assert.strictEqual(AddressIndex.getTransactions(addr(9)).total, 0);
});

test("색인을 비우면 기록이 남지 않는다", () => {
  AddressIndex.reset();
  assert.strictEqual(AddressIndex.getIndexedAddressCount(), 0);
  assert.strictEqual(AddressIndex.hasAddress(addr(1)), false);
});
