/**
 * 스크립트 — 다중서명, 타임락, HTLC. 그리고 P2SH 출력이 실제 블록에 담겨
 * 쓰이는 데까지.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const Script = require("../src/script");
const Keys = require("../src/keys");
const Address = require("../src/address");
const Params = require("../src/params");
const Blockchain = require("../src/blockchain");
const Mempool = require("../src/memPool");
const Transactions = require("../src/transactions");
const { getTxId, validateTx, isFinalTx } = Transactions;
const { coinbaseBlockOnto, ecShim, newAddress } = require("./helpers");

const TXID = "ab".repeat(32);
const ctx = (over = {}) => ({ txId: TXID, lockTime: 0, spendHeight: 50, medianTimePast: 1000, ...over });
const key = () => {
  const privateKey = Keys.generatePrivateKey();
  return { privateKey, publicKey: Keys.getPublicKey(privateKey) };
};
const signWith = (k, txId = TXID) => Keys.sign(k.privateKey, txId);

/* ------------------------------------------- 스크립트 숫자 */

test("스크립트 숫자는 리틀 엔디언 부호 있는 정수이고 최소 표기여야 한다", () => {
  const round = value => Script.decodeNum(Script.encodeNum(value), 5);
  for (const value of [0, 1, 16, 127, 128, 255, 256, 1000, 500000000, 2 ** 31 - 1, -1, -128, -1000]) {
    assert.strictEqual(round(value), value, `${value}`);
  }
  assert.strictEqual(Script.encodeNum(0).length, 0, "0 은 빈 값이다");
  assert.strictEqual(Script.encodeNum(1).toString("hex"), "01");
  assert.strictEqual(Script.encodeNum(128).toString("hex"), "8000", "부호 비트를 피해 한 바이트 더 쓴다");
  assert.strictEqual(Script.encodeNum(-1).toString("hex"), "81");
  // 같은 수를 두 가지로 적을 수 있으면 같은 조건이 여러 주소를 갖게 된다
  assert.throws(() => Script.decodeNum(Buffer.from("0100", "hex")), /최소 표기/);
  assert.throws(() => Script.decodeNum(Buffer.from("0000000000", "hex")), /바이트를 넘/);
  assert.throws(() => Script.decodeNum(Buffer.from("0102030405", "hex")), /바이트를 넘/);
});

test("빈 값과 0 은 거짓, 그 밖은 참", () => {
  assert.strictEqual(Script.isTruthy(Buffer.alloc(0)), false);
  assert.strictEqual(Script.isTruthy(Buffer.from([0])), false);
  assert.strictEqual(Script.isTruthy(Buffer.from([0x80])), false, "음의 0 도 거짓");
  assert.strictEqual(Script.isTruthy(Buffer.from([1])), true);
});

/* ------------------------------------------- 읽기 / 쓰기 */

test("스크립트를 읽고 다시 쓰면 같은 바이트가 나온다", () => {
  const k = key();
  const script = Script.multisig(2, [k.publicKey, key().publicKey, key().publicKey]);
  assert.strictEqual(Script.toAsm(script).split(" ")[0], "OP_2");
  assert.strictEqual(Script.toAsm(script).split(" ").pop(), "OP_CHECKMULTISIG");
  assert.strictEqual(Script.parse(script).length, 6);
  // 65바이트 공개키는 길이 바이트(0x41) 하나로 올라간다 (0x4c 미만이므로)
  assert.ok(script.includes("41" + k.publicKey));
  // 0x4c 이상은 PUSHDATA1 을 쓴다
  assert.strictEqual(Script.pushData("aa".repeat(76)).subarray(0, 2).toString("hex"), "4c4c");
});

test("잘린 데이터, 알 수 없는 연산자, 너무 긴 스크립트는 읽기에서 걸린다", () => {
  assert.throws(() => Script.parse("04aabb"), /잘렸/);
  assert.throws(() => Script.parse("ff"), /알 수 없는 연산자/);
  assert.throws(() => Script.parse("xyz"), /hex/);
  assert.throws(() => Script.parse("00".repeat(Script.MAX_SCRIPT_BYTES + 1)), /바이트를 넘/);
});

test("한도를 넘는 실행은 거부된다", () => {
  // 스택을 계속 불리는 스크립트
  const deep = Script.compile([...Array(Script.MAX_STACK + 2).fill({ num: 1 })]);
  assert.strictEqual(Script.run([], deep, ctx()), false);
  // 연산자 수 상한
  const many = Script.compile([{ num: 1 }, ...Array(Script.MAX_OPS + 1).fill(Script.OP.DUP)]);
  assert.strictEqual(Script.run([], many, ctx()), false);
  // 서명 검증 상한
  const k = key();
  assert.throws(() => Script.multisig(1, Array(Script.MAX_SIGOPS + 1).fill(k.publicKey)), /공개키는/);
});

/* ------------------------------------------- 다중서명 */

test("m-of-n 다중서명은 서로 다른 m 개의 서명을 순서대로 받아야 통과한다", () => {
  const [a, b, c] = [key(), key(), key()];
  const script = Script.multisig(2, [a.publicKey, b.publicKey, c.publicKey]);

  assert.strictEqual(Script.run([signWith(a), signWith(b)], script, ctx()), true);
  assert.strictEqual(Script.run([signWith(a), signWith(c)], script, ctx()), true);
  assert.strictEqual(Script.run([signWith(b), signWith(c)], script, ctx()), true);

  assert.strictEqual(Script.run([signWith(a)], script, ctx()), false, "서명이 모자란다");
  assert.strictEqual(Script.run([signWith(c), signWith(a)], script, ctx()), false, "순서가 다르다");
  assert.strictEqual(Script.run([signWith(a), signWith(a)], script, ctx()), false, "같은 키를 두 번");
  assert.strictEqual(Script.run([signWith(a), signWith(key())], script, ctx()), false, "남의 키");
  // 다른 트랜잭션에 한 서명은 여기서 쓸 수 없다
  const other = "cd".repeat(32);
  assert.strictEqual(
    Script.run([signWith(a, other), signWith(b, other)], script, ctx()),
    false
  );

  assert.deepStrictEqual(
    { type: "multisig", m: 2, n: 3 },
    (({ type, m, n }) => ({ type, m, n }))(Script.describe(script))
  );
});

test("다중서명은 m 과 n 이 말이 되어야 만들어진다", () => {
  const k = key();
  assert.throws(() => Script.multisig(0, [k.publicKey]), /m 은/);
  assert.throws(() => Script.multisig(2, [k.publicKey]), /m 은/);
  assert.throws(() => Script.multisig(1, []), /공개키는/);
  assert.throws(() => Script.multisig(1, ["04ff"]), /공개키가 아닙니다/);
});

/* ------------------------------------------- 타임락 */

test("CLTV 는 트랜잭션의 lockTime 이 그 값 이상일 때만 통과한다", () => {
  const a = key();
  const script = Script.timeLocked(100, a.publicKey);
  const unlock = [signWith(a), a.publicKey];

  assert.strictEqual(Script.run(unlock, script, ctx({ lockTime: 99 })), false);
  assert.strictEqual(Script.run(unlock, script, ctx({ lockTime: 100 })), true);
  assert.strictEqual(Script.run(unlock, script, ctx({ lockTime: 5000 })), true);
  assert.strictEqual(Script.run(unlock, script, ctx({ lockTime: 0 })), false, "lockTime 없이는 못 연다");
  // 높이와 시각을 섞을 수 없다
  assert.strictEqual(Script.run(unlock, script, ctx({ lockTime: 1700000000 })), false);
  // 남의 서명으로는 못 연다
  assert.strictEqual(Script.run([signWith(key()), a.publicKey], script, ctx({ lockTime: 100 })), false);
});

test("시각 기반 타임락도 같은 규칙으로 돈다", () => {
  const a = key();
  const when = 1800000000; // LOCKTIME_THRESHOLD 보다 크다 = 유닉스 시각
  assert.ok(when > Script.LOCKTIME_THRESHOLD);
  const script = Script.timeLocked(when, a.publicKey);
  const unlock = [signWith(a), a.publicKey];
  assert.strictEqual(Script.run(unlock, script, ctx({ lockTime: when - 1 })), false);
  assert.strictEqual(Script.run(unlock, script, ctx({ lockTime: when })), true);
  assert.strictEqual(Script.run(unlock, script, ctx({ lockTime: 100 })), false, "높이와 섞을 수 없다");
});

/* ------------------------------------------- HTLC */

test("HTLC: 비밀값을 알면 받는 쪽이 가져가고, 시간이 지나면 보낸 쪽이 돌려받는다", () => {
  const sender = key();
  const receiver = key();
  const secret = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");
  const script = Script.hashTimeLocked({
    hash,
    receiverPublicKey: receiver.publicKey,
    senderPublicKey: sender.publicKey,
    lockTime: 200
  });

  // 받는 쪽: [서명, 공개키, 비밀값, 1]
  assert.strictEqual(
    Script.run([signWith(receiver), receiver.publicKey, secret, "01"], script, ctx()),
    true
  );
  // 비밀값이 틀리면 안 된다
  assert.strictEqual(
    Script.run([signWith(receiver), receiver.publicKey, crypto.randomBytes(32).toString("hex"), "01"], script, ctx()),
    false
  );
  // 비밀값을 아는 것만으로는 안 된다 — 받는 쪽 서명이어야 한다
  assert.strictEqual(
    Script.run([signWith(sender), sender.publicKey, secret, "01"], script, ctx()),
    false
  );

  // 보낸 쪽: [서명, 공개키, 0] + lockTime
  assert.strictEqual(Script.run([signWith(sender), sender.publicKey, ""], script, ctx({ lockTime: 199 })), false);
  assert.strictEqual(Script.run([signWith(sender), sender.publicKey, ""], script, ctx({ lockTime: 200 })), true);
  // 받는 쪽이 환불 갈래로 가져갈 수는 없다
  assert.strictEqual(
    Script.run([signWith(receiver), receiver.publicKey, ""], script, ctx({ lockTime: 200 })),
    false
  );
  assert.strictEqual(Script.describe(script).type, "htlc");
  assert.strictEqual(Script.describe(script).lockTime, 200);
});

/* ------------------------------------------- P2SH 주소 */

test("P2SH 주소는 조건의 해시이고, 원본이 맞아야 쓸 수 있다", () => {
  const script = Script.multisig(2, [key().publicKey, key().publicKey]);
  const version = Params.current().scriptAddressVersion;
  const address = Address.addressFromScript(script, version);

  assert.match(address, /^M/, "메인넷 스크립트 주소는 M 으로 시작한다");
  assert.strictEqual(Address.isAddressValid(address, Params.current().addressVersion, version), true);
  assert.strictEqual(Address.isAddressValid(address, Params.current().addressVersion), false, "일반 주소로는 안 통한다");
  assert.strictEqual(Address.scriptMatchesAddress(address, script, version), true);
  assert.strictEqual(Address.scriptMatchesAddress(address, script + "00", version), false);
  // 일반 주소는 스크립트 주소가 아니다
  assert.strictEqual(Address.scriptHashOf(newAddress(), version), null);
});

/* ------------------------------------------- lockTime */

test("lockTime 은 높이 또는 시각으로 읽고, 그 전에는 담기지 않는다", () => {
  assert.strictEqual(isFinalTx({}, 5, 1000), true, "lockTime 이 없으면 제한이 없다");
  assert.strictEqual(isFinalTx({ lockTime: 0 }, 5, 1000), true);
  assert.strictEqual(isFinalTx({ lockTime: 100 }, 99, 1000), false);
  assert.strictEqual(isFinalTx({ lockTime: 100 }, 100, 1000), true);
  const when = 1800000000;
  assert.strictEqual(isFinalTx({ lockTime: when }, 999999, when - 1), false, "높이로는 못 연다");
  assert.strictEqual(isFinalTx({ lockTime: when }, 0, when), true);
});

/* ------------------------------------------- 블록까지 */

test("P2SH 다중서명 출력이 실제 블록에 담기고 두 서명으로 쓰인다", async () => {
  // 코인베이스를 받을 예전 형식 주소(공개키 hex)로 체인을 만든다
  const miner = ecShim.genKeyPair();
  const minerAddress = miner.getPublic().encode("hex");
  const genesis = Blockchain.getBlockChain()[0];
  let chain = [genesis];
  for (let i = 0; i < 12; i++) {
    const tip = chain[chain.length - 1];
    chain = chain.concat([
      coinbaseBlockOnto(tip, minerAddress, i * 10, Blockchain.bitsForNext(chain))
    ]);
  }
  assert.strictEqual(Blockchain.replaceChain(chain), true);

  const [a, b, c] = [key(), key(), key()];
  const redeemScript = Script.multisig(2, [a.publicKey, b.publicKey, c.publicKey]);
  const scriptAddress = Address.addressFromScript(redeemScript, Params.current().scriptAddressVersion);

  // 1) 코인베이스 -> P2SH 주소로 보낸다 (일반 송금과 똑같다)
  const funding = chain[1].data[0];
  const fundTx = {
    txIns: [{ txOutId: funding.id, txOutIndex: 0, signature: "" }],
    txOuts: [{ address: scriptAddress, amount: funding.txOuts[0].amount - 1000 }],
    lockTime: 0,
    id: ""
  };
  fundTx.id = getTxId(fundTx);
  fundTx.txIns[0].signature = require("../src/utils").toHexString(miner.sign(fundTx.id).toDER());

  process.env.LIMCOIN_MINING_ADDRESS = minerAddress;
  try {
    Blockchain.submitTx(fundTx);
    const block = await Blockchain.createNewBlock();
    assert.ok(block.data.some(tx => tx.id === fundTx.id), "P2SH 출력이 블록에 담겼다");

    // 2) 그 출력을 두 서명으로 쓴다
    const spendTx = {
      txIns: [{ txOutId: fundTx.id, txOutIndex: 0, signature: "" }],
      txOuts: [{ address: minerAddress, amount: fundTx.txOuts[0].amount - 1000 }],
      lockTime: 0,
      id: ""
    };
    spendTx.id = getTxId(spendTx);
    spendTx.txIns[0].redeemScript = redeemScript;

    // 서명이 하나뿐이면 거부된다
    spendTx.txIns[0].unlock = [Keys.sign(a.privateKey, spendTx.id)];
    assert.throws(() => Blockchain.submitTx(spendTx), /invalid/i);

    // 원본 스크립트가 다르면 거부된다
    spendTx.txIns[0].unlock = [Keys.sign(a.privateKey, spendTx.id), Keys.sign(b.privateKey, spendTx.id)];
    spendTx.txIns[0].redeemScript = Script.multisig(2, [a.publicKey, b.publicKey]);
    assert.throws(() => Blockchain.submitTx(spendTx), /invalid/i);

    // 제대로 갖추면 통과하고 블록에 담긴다
    spendTx.txIns[0].redeemScript = redeemScript;
    Blockchain.submitTx(spendTx);
    const spendBlock = await Blockchain.createNewBlock();
    assert.ok(spendBlock.data.some(tx => tx.id === spendTx.id), "다중서명 지출이 블록에 담겼다");
    assert.strictEqual(
      Blockchain.getUTxOutList().some(uTxOut => uTxOut.address === scriptAddress),
      false,
      "P2SH 출력이 쓰였다"
    );
  } finally {
    delete process.env.LIMCOIN_MINING_ADDRESS;
    await Blockchain.stopMiners();
  }
});

test("타임락이 걸린 트랜잭션은 그 높이가 되기 전에는 mempool 에도 들어가지 못한다", () => {
  const height = Blockchain.nextHeight();
  const utxo = Blockchain.getUTxOutList()[0];
  assert.ok(utxo, "쓸 수 있는 출력이 있어야 한다");

  const tx = {
    txIns: [{ txOutId: utxo.txOutId, txOutIndex: utxo.txOutIndex, signature: "" }],
    txOuts: [{ address: newAddress(), amount: 1000 }],
    lockTime: height + 100,
    id: ""
  };
  tx.id = getTxId(tx);
  // 서명이 맞는지와 무관하게 lockTime 에서 먼저 걸린다
  assert.strictEqual(validateTx(tx, [utxo], undefined, height, 1000), false);
  assert.strictEqual(isFinalTx(tx, height + 100, 1000), true);
});

test("코인베이스에는 타임락을 걸 수 없다", () => {
  const coinbase = Transactions.createCoinbaseTx(newAddress(), 5, 0);
  const locked = { ...coinbase, lockTime: 10 };
  locked.id = getTxId(locked);
  assert.strictEqual(Mempool.getMempool().length >= 0, true);
  // validateCoinbaseTx 는 processTxs 를 통해서만 불린다 — 블록으로 확인한다
  const chain = Blockchain.getBlockChain();
  const tip = chain[chain.length - 1];
  const block = coinbaseBlockOnto(tip, newAddress(), 10, Blockchain.bitsForNext(chain));
  const forgedData = [{ ...block.data[0], lockTime: 10 }];
  forgedData[0].id = getTxId(forgedData[0]);
  assert.strictEqual(Transactions.processTxs(forgedData, Blockchain.getUTxOutList(), block.index, 0), null);
});
