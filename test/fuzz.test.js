/**
 * 퍼징과 불변식.
 *
 * 다른 테스트는 "이 입력이면 이 답"을 본다. 여기는 반대다 —
 * **아무 입력이나** 잔뜩 만들어 넣고, 어떤 입력이 와도 깨지지 않아야 하는
 * 성질만 본다.
 *
 *   1. 남이 보낸 것을 다루는 자리는 던지지 않는다 (노드가 안 죽는다)
 *   2. 왕복은 제자리로 돌아온다 (encode∘decode = id)
 *   3. 순서가 있는 값은 순서가 보존된다 (목표값 ↔ 일한 양)
 *
 * 난수는 씨앗을 고정한다. 실패하면 같은 입력이 다시 나와야 고칠 수 있다.
 * 씨앗을 바꿔 돌려 보고 싶으면 LIMCOIN_FUZZ_SEED 를 준다.
 */
process.env.LIMCOIN_NETWORK = "regtest";

const test = require("node:test");
const assert = require("node:assert");

const P2P = require("../src/p2p");
const Script = require("../src/script");
const S = require("../src/serialization");
const Address = require("../src/address");
const Target = require("../src/target");
const Merkle = require("../src/merkle");
const Units = require("../src/units");
const Rpc = require("../src/rpc");
const Keys = require("../src/keys");
const Params = require("../src/params");
const Transactions = require("../src/transactions");
const { getTxId, validateTx } = Transactions;

const SEED = Number(process.env.LIMCOIN_FUZZ_SEED || 20260909);

// 씨앗을 고정한 난수 (LCG). Math.random 을 쓰면 실패를 다시 못 만든다.
const rngFrom = seed => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const int = (rng, n) => Math.floor(rng() * n);

// 아무 JSON 값이나. depth 로 재귀를 막는다.
const anyValue = (rng, depth = 0) => {
  const leaves = [
    () => null,
    () => undefined,
    () => true,
    () => false,
    () => 0,
    () => -1,
    () => int(rng, 1e9),
    () => -int(rng, 1e9),
    () => Number.MAX_SAFE_INTEGER + int(rng, 1000),
    () => NaN,
    () => Infinity,
    () => "",
    () => "문자열",
    () => "0".repeat(int(rng, 200)),
    () => Array.from({ length: int(rng, 40) }, () => "0123456789abcdef"[int(rng, 16)]).join("")
  ];
  if (depth >= 3 || rng() < 0.6) {
    return pick(rng, leaves)();
  }
  if (rng() < 0.5) {
    return Array.from({ length: int(rng, 5) }, () => anyValue(rng, depth + 1));
  }
  const keys = ["type", "data", "work", "locator", "blocks", "headers", "height", "id", "peers", "x"];
  const object = {};
  for (let i = 0, n = int(rng, 5); i < n; i++) {
    object[pick(rng, keys)] = anyValue(rng, depth + 1);
  }
  return object;
};

/* ------------------------------------------- 1. 던지지 않는다 */

test("P2P 는 어떤 메시지를 받아도 던지지 않는다", () => {
  const rng = rngFrom(SEED);
  const types = [
    "GET_LATEST", "GET_HEADERS", "GET_BLOCKS", "BLOCKCHAIN_RESPONSE",
    "HEADERS_RESPONSE", "BLOCKS_RESPONSE", "REQUEST_MEMPOOL", "MEMPOOL_RESPONSE",
    "HELLO", "GET_PEERS", "PEERS_RESPONSE", "없는타입", ""
  ];
  const socket = () => ({ readyState: 0, sent: [], banScore: 0 });

  for (let i = 0; i < 1500; i++) {
    // 절반은 아무 값, 절반은 진짜 type 에 아무 본문 — 뒤쪽이 더 깊이 들어간다
    const message = rng() < 0.5
      ? anyValue(rng)
      : { type: pick(rng, types), data: anyValue(rng), work: anyValue(rng) };
    assert.doesNotThrow(
      () => P2P.handleMessage(socket(), message),
      `${i}번째: ${JSON.stringify(message)}`
    );
  }
});

/*
 * 무작위 바이트만 넣으면 대개 첫 관문에서 걸려 해석기 안쪽까지 가지 못한다.
 * 그래서 진짜 연산자와 제대로 된 push 로 "그럴듯한" 스크립트를 짓는다.
 * 절반은 순수 난수로 남겨 둔다 — 관문 자체도 시험해야 한다.
 */
const plausibleScript = rng => {
  const keys = Object.keys(Script.OP);
  const parts = [];
  for (let n = 1 + int(rng, 12); n > 0; n--) {
    const roll = rng();
    if (roll < 0.35) {
      parts.push(Script.OP[pick(rng, keys)]); // 연산자
    } else if (roll < 0.6) {
      parts.push({ num: int(rng, 2 ** 20) * (rng() < 0.3 ? -1 : 1) });
    } else if (roll < 0.8) {
      // 공개키·해시처럼 생긴 것 — 서명 검사까지 들어가 본다
      const size = pick(rng, [20, 32, 33, 65, 71, int(rng, 80)]);
      parts.push({
        data: Buffer.from(Array.from({ length: size }, () => int(rng, 256))).toString("hex")
      });
    } else {
      parts.push(pick(rng, [Script.OP.IF, Script.OP.NOTIF, Script.OP.ELSE, Script.OP.ENDIF]));
    }
  }
  try {
    return Script.compile(parts);
  } catch {
    return "";
  }
};

test("스크립트 해석기는 아무 바이트나 받아도 던지지 않는다", () => {
  const rng = rngFrom(SEED + 1);
  const ctx = { txId: "ab".repeat(32), lockTime: 0, height: 1, mtp: 0 };
  let ran = 0;

  for (let i = 0; i < 2500; i++) {
    const bytes = rng() < 0.5
      ? plausibleScript(rng)
      : Buffer.from(Array.from({ length: int(rng, 60) }, () => int(rng, 256))).toString("hex");
    const unlock = Array.from({ length: int(rng, 4) }, () =>
      Buffer.from(Array.from({ length: int(rng, 40) }, () => int(rng, 256))).toString("hex")
    );

    // run 은 무엇이 오든 true/false 만 낸다 (안에서 잡는다)
    const result = Script.run(unlock, bytes, ctx);
    assert.strictEqual(typeof result, "boolean", `${i}번째: ${bytes}`);
    if (result) {
      ran++; // 끝까지 돌아 참이 남은 것
    }

    // parse 는 던져도 되지만 Error 여야 한다 (TypeError·RangeError 로 죽지 않는다)
    try {
      const parsed = Script.parse(bytes);
      assert.ok(Array.isArray(parsed));
      assert.strictEqual(typeof Script.toAsm(bytes), "string");
    } catch (e) {
      assert.strictEqual(e.constructor, Error, `${i}번째 ${bytes}: ${e.constructor.name}`);
    }
  }

  // 전부 첫 관문에서 걸렸다면 해석기를 시험한 것이 아니다.
  // (끝까지 돌아 참이 남으려면 우연이 겹쳐야 해서 비율 자체는 낮다)
  assert.ok(ran > 10, `끝까지 돌아 참이 남은 스크립트가 ${ran}개뿐이다 — 퍼저가 얕다`);
});

test("raw 디코더는 아무 hex 나 받아도 Error 만 던진다", () => {
  const rng = rngFrom(SEED + 2);

  // 멀쩡한 트랜잭션 하나를 만들어 두고 여기서 비틀어 낸다.
  // 순수 난수는 첫 varint 에서 거의 다 걸려 리더 안쪽까지 가지 못한다.
  const key = Keys.generatePrivateKey();
  const pub = Keys.getPublicKey(key);
  const addr = Address.addressFromPublicKey(pub, Params.current().addressVersion);
  const seedTx = {
    txIns: [
      { txOutId: "ab".repeat(32), txOutIndex: 0, signature: "" },
      { txOutId: "cd".repeat(32), txOutIndex: 7, signature: "", redeemScript: "51", unlock: ["00", "0102"] }
    ],
    txOuts: [{ address: addr, amount: 12345 }, { address: addr, amount: 1 }],
    lockTime: 0
  };
  seedTx.id = getTxId(seedTx);
  seedTx.txIns[0].signature = Keys.sign(key, seedTx.id);
  seedTx.txIns[0].publicKey = pub;
  const good = S.encodeTx(seedTx);
  assert.strictEqual(S.encodeTx(S.decodeTx(good)), good, "씨앗부터 왕복해야 한다");

  const mutate = () => {
    const roll = rng();
    if (roll < 0.35) {
      // 바이트 하나 뒤집기
      const at = int(rng, good.length / 2) * 2;
      const byte = int(rng, 256).toString(16).padStart(2, "0");
      return good.slice(0, at) + byte + good.slice(at + 2);
    }
    if (roll < 0.6) {
      return good.slice(0, int(rng, good.length / 2) * 2); // 자르기
    }
    if (roll < 0.75) {
      return good + int(rng, 256).toString(16).padStart(2, "0"); // 덧붙이기
    }
    return Array.from({ length: int(rng, 120) }, () => "0123456789abcdef"[int(rng, 16)]).join("");
  };

  let read = 0;
  for (let i = 0; i < 3000; i++) {
    const hex = mutate();
    for (const decode of [S.decodeTx, S.decodeBlock]) {
      try {
        const value = decode(hex);
        read++;
        // 어쩌다 읽혔다면 다시 적었을 때 같은 바이트여야 한다
        const again = decode === S.decodeTx ? S.encodeTx(value) : S.encodeBlock(value);
        assert.strictEqual(again, hex.toLowerCase(), `${i}번째 왕복이 어긋난다: ${hex}`);
      } catch (e) {
        assert.strictEqual(e.constructor, Error, `${i}번째 ${hex}: ${e.constructor.name} ${e.message}`);
      }
    }
  }

  assert.ok(read > 20, `읽히는 데까지 간 것이 ${read}개뿐이다 — 퍼저가 얕다`);
});

test("주소·금액 해석기는 아무 문자열이나 받아도 던지지 않는다", () => {
  const rng = rngFrom(SEED + 3);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0OIl+/= 한";
  const version = Params.current().addressVersion;

  for (let i = 0; i < 2000; i++) {
    const str = Array.from({ length: int(rng, 45) }, () => pick(rng, alphabet.split(""))).join("");
    assert.doesNotThrow(() => Address.decodeAddress(str));
    assert.doesNotThrow(() => Address.isAddressValid(str, version));
    assert.doesNotThrow(() => Address.isBase58Address(str, version));
    assert.doesNotThrow(() => Address.scriptHashOf(str, Params.current().scriptAddressVersion));
    assert.strictEqual(typeof Address.isAddressValid(str, version), "boolean");

    // 금액 문자열도 같은 자리다 (RPC 가 사용자 입력을 그대로 넘긴다)
    try {
      const lm = Units.parseLim(str);
      assert.ok(Number.isSafeInteger(lm), `parseLim("${str}") = ${lm}`);
    } catch (e) {
      assert.strictEqual(e.constructor, Error, `${str}: ${e.constructor.name}`);
    }
  }
});

test("RPC 는 아무 요청이나 받아도 규약에 맞는 답을 준다", () => {
  const rng = rngFrom(SEED + 4);
  const names = Object.keys(Rpc.methods);

  const wellFormed = answer => {
    assert.ok(answer !== null && typeof answer === "object");
    assert.ok("result" in answer && "error" in answer && "id" in answer);
    if (answer.error !== null) {
      assert.strictEqual(answer.result, null);
      assert.strictEqual(typeof answer.error.code, "number");
      assert.strictEqual(typeof answer.error.message, "string");
    }
  };

  for (let i = 0; i < 1500; i++) {
    const request = rng() < 0.4
      ? anyValue(rng)
      : { jsonrpc: "2.0", id: int(rng, 100), method: pick(rng, names), params: anyValue(rng) };
    let answer;
    assert.doesNotThrow(() => {
      answer = Rpc.call(request, rng() < 0.5);
    }, `${i}번째: ${JSON.stringify(request)}`);
    if (Array.isArray(answer)) {
      answer.forEach(wellFormed);
    } else {
      wellFormed(answer);
    }
  }
});

test("망가뜨린 트랜잭션은 거부되지 다르게 처리되지 않는다", () => {
  const rng = rngFrom(SEED + 5);
  const key = Keys.generatePrivateKey();
  const pub = Keys.getPublicKey(key);
  const addr = Address.addressFromPublicKey(pub, Params.current().addressVersion);
  const txOutId = "ab".repeat(32);

  const uTxOutList = [{ txOutId, txOutIndex: 0, address: addr, amount: 100000, blockIndex: null }];

  const fresh = () => {
    const tx = {
      txIns: [{ txOutId, txOutIndex: 0, signature: "" }],
      txOuts: [{ address: addr, amount: 90000 }],
      lockTime: 0
    };
    tx.id = getTxId(tx);
    tx.txIns[0].signature = Keys.sign(key, tx.id);
    tx.txIns[0].publicKey = pub;
    return tx;
  };

  // 먼저 멀쩡한 것은 통과해야 한다 (아니면 아래가 의미 없다)
  assert.strictEqual(validateTx(fresh(), uTxOutList, undefined, 1, 0), true);

  // 앞선 변형이 배열을 비웠을 수 있다 — 없는 자리는 건드리지 않는다
  const spots = [
    tx => { tx.id = "cd".repeat(32); },
    tx => { if (tx.txIns[0]) tx.txIns[0].signature = "00"; },
    tx => { if (tx.txIns[0]) tx.txIns[0].signature = ""; },
    tx => { if (tx.txIns[0]) tx.txIns[0].publicKey = Keys.getPublicKey(Keys.generatePrivateKey()); },
    tx => { if (tx.txIns[0]) tx.txIns[0].txOutIndex = 1; },
    tx => { if (tx.txOuts[0]) tx.txOuts[0].amount = 200000; },
    tx => { if (tx.txOuts[0]) tx.txOuts[0].amount = -1; },
    tx => { if (tx.txOuts[0]) tx.txOuts[0].amount = 0.5; },
    tx => { if (tx.txOuts[0]) tx.txOuts[0].address = "없는주소"; },
    tx => { if (tx.txIns[0]) tx.txIns.push(tx.txIns[0]); },
    tx => { tx.txOuts = []; },
    tx => { tx.txIns = []; },
    tx => { if (tx.txIns[0]) delete tx.txIns[0].publicKey; },
    tx => { tx.lockTime = 4000000000; },
    tx => { if (tx.txOuts[0]) tx.txOuts[0].amount = Number.MAX_SAFE_INTEGER; }
  ];

  for (let i = 0; i < 600; i++) {
    const tx = fresh();
    // 한 군데에서 세 군데까지 망가뜨린다
    for (let n = 1 + int(rng, 3); n > 0; n--) {
      pick(rng, spots)(tx);
    }
    let verdict;
    assert.doesNotThrow(() => {
      verdict = validateTx(tx, uTxOutList, undefined, 1, 0);
    }, `${i}번째: ${JSON.stringify(tx)}`);
    assert.strictEqual(verdict, false, `${i}번째가 통과했다: ${JSON.stringify(tx)}`);
  }
});

/* ------------------------------------------- 2. 왕복 */

test("Base58Check 와 varint 는 왕복한다", () => {
  const rng = rngFrom(SEED + 6);

  for (let i = 0; i < 800; i++) {
    const payload = Buffer.from(Array.from({ length: 1 + int(rng, 40) }, () => int(rng, 256)));
    const encoded = Address.base58CheckEncode(payload);
    assert.deepStrictEqual(Address.base58CheckDecode(encoded), payload, `payload ${payload.toString("hex")}`);

    // 한 글자만 바꾸면 체크섬에 걸린다
    const at = int(rng, encoded.length);
    const other = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[int(rng, 58)];
    if (other !== encoded[at]) {
      const broken = encoded.slice(0, at) + other + encoded.slice(at + 1);
      assert.strictEqual(Address.base58CheckDecode(broken), null, `${broken} 가 통과했다`);
    }
  }

  // varint 는 경계값 언저리를 훑는다
  const boundaries = [0, 1, 252, 253, 254, 65535, 65536, 4294967295, 4294967296];
  const values = boundaries.concat(
    Array.from({ length: 300 }, () => int(rng, 2 ** 32))
  );
  for (const value of values) {
    const buf = S.writeVarint(value);
    assert.strictEqual(buf.length, S.varintSize(value), `varint ${value} 길이가 안 맞는다`);
    // 트랜잭션 안에 넣어 왕복시켜 본다 (varint 를 직접 읽는 함수는 안 열려 있다)
    if (value >= 1 && value <= 200) {
      const tx = {
        txIns: [{ txOutId: "ab".repeat(32), txOutIndex: 0, signature: "" }],
        txOuts: Array.from({ length: value }, () => ({ address: "L".repeat(34), amount: 1 })),
        lockTime: 0
      };
      tx.id = getTxId(tx);
      assert.strictEqual(S.decodeTx(S.encodeTx(tx)).txOuts.length, value);
    }
  }
});

test("스크립트 숫자는 왕복하고, 최소 길이로만 적힌다", () => {
  const rng = rngFrom(SEED + 7);
  const values = [0, 1, -1, 127, -127, 128, -128, 255, -255, 256, 32767, -32768, 2 ** 31 - 1]
    .concat(Array.from({ length: 500 }, () => int(rng, 2 ** 31) * (rng() < 0.5 ? -1 : 1)));

  for (const value of values) {
    const buf = Script.encodeNum(value);
    assert.strictEqual(Script.decodeNum(buf), value, `${value} 왕복 실패`);
    if (buf.length > 0) {
      const last = buf[buf.length - 1];
      assert.ok(
        (last & 0x7f) !== 0 || (buf.length > 1 && (buf[buf.length - 2] & 0x80) !== 0),
        `${value} 가 최소 길이가 아니다: ${buf.toString("hex")}`
      );
    }
  }
});

test("머클 증명은 어느 잎에서든 루트로 되돌아간다", () => {
  const rng = rngFrom(SEED + 8);

  for (let n = 1; n <= 33; n++) {
    const txs = Array.from({ length: n }, (unused, i) => ({
      id: require("crypto").createHash("sha256").update(`${SEED}:${n}:${i}`).digest("hex")
    }));
    const root = Merkle.getMerkleRoot(txs);
    for (const tx of txs) {
      const proof = Merkle.getMerkleProof(txs, tx.id);
      assert.notStrictEqual(proof, null, `${n}개 중 ${tx.id} 의 증명이 없다`);
      assert.strictEqual(Merkle.verifyMerkleProof(tx.id, proof, root), true, `${n}개, 증명 ${proof.length}단`);

      // 남의 id 로는 통하지 않는다
      const other = pick(rng, txs).id;
      if (other !== tx.id) {
        assert.strictEqual(Merkle.verifyMerkleProof(other, proof, root), false);
      }
    }
  }
});

/* ------------------------------------------- 3. 순서 */

test("압축 목표값은 왕복하고, 목표가 클수록 일한 양이 적다", () => {
  const rng = rngFrom(SEED + 9);

  // 유효한 bits 를 만들어 훑는다: 지수 3..32, 가수 0x008000..0x7fffff
  const samples = [];
  for (let i = 0; i < 800; i++) {
    const exponent = 3 + int(rng, 30);
    const mantissa = 0x008000 + int(rng, 0x7fffff - 0x008000);
    samples.push((exponent << 24) | mantissa);
  }
  samples.push(Target.POW_LIMIT_BITS);

  let checked = 0;
  for (const bits of samples) {
    if (!Target.isValidBits(bits)) {
      continue;
    }
    checked++;
    const target = Target.targetFromBits(bits);
    assert.ok(target > 0n, `${bits.toString(16)} 의 목표값이 0 이다`);
    assert.strictEqual(Target.bitsFromTarget(target), bits >>> 0, `${bits.toString(16)} 왕복 실패`);
    assert.ok(Target.workOf(bits) > 0n);
    assert.ok(Target.difficultyOf(bits) > 0);

    // 목표값을 두 배로 하면(=쉬워지면) 일한 양이 줄어야 한다
    const easier = Target.bitsFromTarget(target * 2n);
    if (Target.isValidBits(easier) && Target.targetFromBits(easier) > target) {
      assert.ok(
        Target.workOf(easier) < Target.workOf(bits),
        `쉬워졌는데 일한 양이 안 줄었다: ${bits.toString(16)} → ${easier.toString(16)}`
      );
      assert.ok(Target.difficultyOf(easier) < Target.difficultyOf(bits));
    }
  }
  assert.ok(checked > 400, `유효한 표본이 ${checked}개뿐이다`);
});

test("바닥보다 쉬운 목표값과 이상한 bits 는 거부된다", () => {
  const rng = rngFrom(SEED + 10);

  assert.strictEqual(Target.isValidBits(0), false, "0 은 목표값이 아니다");
  assert.strictEqual(Target.isValidBits(0x00000000 | 0x7fffff), false, "지수 0");
  assert.strictEqual(Target.isValidBits((3 << 24) | 0x800000), false, "가수 최상위 비트(음수)");
  assert.strictEqual(Target.isValidBits(Target.POW_LIMIT_BITS), true);

  for (let i = 0; i < 500; i++) {
    const bits = int(rng, 2 ** 32);
    assert.doesNotThrow(() => Target.isValidBits(bits), `${bits}`);
    if (Target.isValidBits(bits)) {
      assert.ok(Target.targetFromBits(bits) <= Target.POW_LIMIT, `${bits.toString(16)} 가 바닥보다 쉽다`);
    }
  }
});
