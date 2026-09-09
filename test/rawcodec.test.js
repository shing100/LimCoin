/**
 * raw 트랜잭션·블록 형식 — hex 로 내보내고 되읽기.
 *
 * txid 를 내는 직렬화와는 다른 형식이다. 그쪽은 해제 데이터를 빼지만
 * 이쪽은 전부 담는다. 두 형식이 서로를 망가뜨리지 않는지도 함께 본다.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const S = require("../src/serialization");
const { getTxId } = require("../src/transactions");
const Script = require("../src/script");
const Keys = require("../src/keys");
const genesis = require("../src/genesis.json");

const withId = tx => ({ ...tx, id: getTxId(tx) });

/* ------------------------------------------- 왕복 */

test("보통 트랜잭션은 hex 로 나갔다가 그대로 돌아온다", () => {
  const tx = withId({
    txIns: [{ txOutId: "ab".repeat(32), txOutIndex: 3, signature: "30".repeat(71), publicKey: "04" + "aa".repeat(64) }],
    txOuts: [{ address: "LhkDDbkPwApRDnBrncVUvLn9ZGocMALgCD", amount: 12345678 }],
    lockTime: 0
  });
  const hex = S.encodeTx(tx);
  assert.match(hex, /^[0-9a-f]+$/);
  assert.deepStrictEqual(S.decodeTx(hex), tx);
  // 되읽은 id 는 내용에서 다시 계산한다 — 보낸 쪽이 적어 준 값을 믿지 않는다
  assert.strictEqual(S.decodeTx(hex).id, getTxId(tx));
});

test("코인베이스의 빈 txOutId 와 여러 출력도 그대로 돌아온다", () => {
  const coinbase = withId({
    txIns: [{ txOutId: "", txOutIndex: 7, signature: "" }],
    txOuts: [{ address: "LhkDDbkPwApRDnBrncVUvLn9ZGocMALgCD", amount: 1000000000 }],
    lockTime: 0
  });
  assert.deepStrictEqual(S.decodeTx(S.encodeTx(coinbase)), coinbase);

  const many = withId({
    txIns: [{ txOutId: "11".repeat(32), txOutIndex: 0, signature: "aa" }],
    txOuts: Array.from({ length: 300 }, (unused, i) => ({ address: `L주소${i}`, amount: i + 1 })),
    lockTime: 4294967295
  });
  // 출력이 253개를 넘으면 varint 가 한 바이트를 넘는다
  assert.deepStrictEqual(S.decodeTx(S.encodeTx(many)), many);
});

test("스크립트 입력(redeemScript, unlock)도 그대로 돌아온다", () => {
  const a = Keys.generatePrivateKey();
  const b = Keys.generatePrivateKey();
  const redeemScript = Script.multisig(2, [Keys.getPublicKey(a), Keys.getPublicKey(b)]);
  const tx = withId({
    txIns: [
      {
        txOutId: "cd".repeat(32),
        txOutIndex: 0,
        signature: "",
        redeemScript,
        // 빈 항목(거짓)도 순서와 함께 지켜져야 한다 — HTLC 의 환불 갈래가 이 모양이다
        unlock: [Keys.sign(a, "ab".repeat(32)), Keys.sign(b, "ab".repeat(32)), ""]
      }
    ],
    txOuts: [{ address: "MTApFeznp7NEcv4x2Ep7fbeqrzF3WAo3Xo", amount: 5 }],
    lockTime: 500001
  });
  const back = S.decodeTx(S.encodeTx(tx));
  assert.deepStrictEqual(back, tx);
  assert.strictEqual(back.txIns[0].unlock.length, 3);
  assert.strictEqual(back.txIns[0].unlock[2], "");
});

test("없는 항목은 되읽어도 없다 (JSON 모양이 같아야 한다)", () => {
  const tx = withId({
    txIns: [{ txOutId: "11".repeat(32), txOutIndex: 0, signature: "aa" }],
    txOuts: [{ address: "L", amount: 1 }],
    lockTime: 0
  });
  const back = S.decodeTx(S.encodeTx(tx));
  assert.strictEqual("publicKey" in back.txIns[0], false);
  assert.strictEqual("redeemScript" in back.txIns[0], false);
  assert.strictEqual("unlock" in back.txIns[0], false);
});

test("raw 형식은 txid 전제를 바꾸지 않는다", () => {
  const base = {
    txIns: [{ txOutId: "ab".repeat(32), txOutIndex: 1 }],
    txOuts: [{ address: "LimAddr", amount: 1000 }],
    lockTime: 0
  };
  const signed = withId({ ...base, txIns: [{ ...base.txIns[0], signature: "3044", publicKey: "04ff" }] });
  // 서명이 달라도 id 는 같다 (malleability 없음). raw 는 달라진다.
  const other = { ...signed, txIns: [{ ...signed.txIns[0], signature: "3045" }] };
  assert.strictEqual(getTxId(other), signed.id);
  assert.notStrictEqual(S.encodeTx(other), S.encodeTx(signed));
});

/* ------------------------------------------- 블록 */

test("블록은 헤더 88바이트 + 트랜잭션들이다", () => {
  const hex = S.encodeBlock(genesis);
  assert.strictEqual(hex.slice(0, 176), S.serializeHeader(genesis).toString("hex"));
  const back = S.decodeBlock(hex);
  assert.strictEqual(back.hash, genesis.hash);
  assert.strictEqual(back.merkleRoot, genesis.merkleRoot);
  assert.strictEqual(back.data.length, genesis.data.length);
  assert.strictEqual(back.data[0].id, genesis.data[0].id);
  assert.strictEqual(back.previousHash, genesis.previousHash);
});

/* ------------------------------------------- 잘못된 입력 */

test("잘린 것, 남는 것, hex 가 아닌 것은 거부한다", () => {
  const tx = withId({
    txIns: [{ txOutId: "11".repeat(32), txOutIndex: 0, signature: "aa" }],
    txOuts: [{ address: "L", amount: 1 }],
    lockTime: 0
  });
  const hex = S.encodeTx(tx);
  assert.throws(() => S.decodeTx(hex + "00"), /남았습니다/);
  assert.throws(() => S.decodeTx(hex.slice(0, -4)), /모자랍니다/);
  assert.throws(() => S.decodeTx("zz"), /hex/);
  assert.throws(() => S.decodeTx("0"), /hex/);
  assert.throws(() => S.decodeTx(""), /입력이 없습니다|모자랍니다/);
  // 입력이나 출력이 하나도 없는 것은 트랜잭션이 아니다
  assert.throws(() => S.decodeTx("00"), /입력이 없습니다/);
});

test("varint 는 최소 표기여야 한다", () => {
  /*
   * 같은 수를 여러 가지로 적을 수 있으면 같은 트랜잭션이 여러 hex 를 갖는다.
   * 입력 1개를 0xfd 0x0100 으로 적은 것을 거부해야 한다.
   */
  assert.throws(() => S.decodeTx("fd0100" + "11".repeat(32) + "00000000" + "00" + "00" + "00" + "00" + "01" + "01" + "4c" + "0100000000000000" + "00000000"), /최소 표기/);
});

test("금액이 안전한 정수 범위를 넘으면 거부한다", () => {
  // uint64 는 2^53 을 넘을 수 있지만 JavaScript 의 정수는 거기까지다
  const hex =
    "01" + "11".repeat(32) + "00000000" + "00" + "00" + "00" + "00" +
    "01" + "01" + "4c" + "ffffffffffffffff" + "00000000";
  assert.throws(() => S.decodeTx(hex), /안전한 정수/);
});

/* ------------------------------------------- 무작위 왕복 */

test("무작위로 만든 트랜잭션 200개가 모두 왕복한다", () => {
  // 씨앗을 고정해 실패하면 그대로 다시 볼 수 있게 한다
  let seed = 20260909;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = n => Math.floor(random() * n);
  const hex = bytes => crypto.randomBytes(bytes).toString("hex");

  for (let round = 0; round < 200; round++) {
    const txIns = Array.from({ length: 1 + pick(4) }, () => {
      const txIn = {
        txOutId: pick(10) === 0 ? "" : hex(32),
        txOutIndex: pick(1000),
        signature: pick(3) === 0 ? "" : hex(60 + pick(12))
      };
      if (pick(2) === 0) {
        txIn.publicKey = hex(65);
      }
      if (pick(3) === 0) {
        txIn.redeemScript = hex(1 + pick(200));
        txIn.unlock = Array.from({ length: pick(4) }, () => (pick(4) === 0 ? "" : hex(1 + pick(80))));
        if (txIn.unlock.length === 0) {
          delete txIn.unlock;
        }
      }
      return txIn;
    });
    const txOuts = Array.from({ length: 1 + pick(3) }, () => ({
      address: ["L" + hex(16), "M" + hex(16), "04" + hex(64), "주소" + pick(100)][pick(4)],
      amount: 1 + pick(1000000)
    }));
    const tx = withId({ txIns, txOuts, lockTime: pick(2) === 0 ? 0 : pick(4294967295) });
    assert.deepStrictEqual(S.decodeTx(S.encodeTx(tx)), tx, `round ${round}`);
  }
});

test("UTF-8 이 아닌 주소 바이트는 거부한다 (퍼저가 찾은 것)", () => {
  /*
   * Buffer.toString("utf8") 은 읽을 수 없는 바이트를 U+FFFD 로 바꿔 준다.
   * 그 문자열을 다시 적으면 1바이트가 3바이트가 되어 왕복이 깨졌다. 더 나쁜
   * 것은 서로 다른 바이트열이 모두 같은 트랜잭션으로 읽혀 같은 txid 가 되는
   * 것이다. 주소는 Base58 이나 공개키 hex 라 늘 ASCII 다 — 아니면 거부한다.
   */
  const bad = Buffer.concat([
    Buffer.from([0x01]), // 입력 1개
    Buffer.alloc(32, 0xab),
    Buffer.from([0, 0, 0, 0]), // txOutIndex
    Buffer.from([0, 0, 0, 0]), // signature/publicKey/redeemScript 없음, unlock 0개
    Buffer.from([0x01]), // 출력 1개
    Buffer.from([0x01, 0xbc]), // 주소 1바이트 = 0xbc — UTF-8 이 아니다
    Buffer.alloc(8), // amount
    Buffer.from([0, 0, 0, 0]) // lockTime
  ]).toString("hex");

  assert.throws(() => S.decodeTx(bad), /UTF-8/);

  // 같은 자리에 ASCII 를 넣으면 읽히고, 왕복도 한다
  const ok = bad.replace("01bc", "014c"); // 'L'
  assert.strictEqual(S.encodeTx(S.decodeTx(ok)), ok);
});
