/**
 * 암호 기본 요소 — 알려진 벡터로 확인한다.
 *
 * 라이브러리를 바꿨을 때(crypto-js/elliptic -> Node crypto) 같은 답을 내는지는
 * 외부에서 검증된 값과 견줘야 안다. 우리 코드로 만든 값을 우리 코드로 확인하는
 * 것은 아무것도 증명하지 않는다.
 */
const test = require("node:test");
const assert = require("node:assert");

const Keys = require("../src/keys");
const S = require("../src/serialization");
const Address = require("../src/address");
const { leadingZeroBits, hashMatchesDifficulty } = require("../src/pow");
const { getMerkleRoot } = require("../src/merkle");

/* ------------------------------------------- 해시 */

test("sha256d 는 알려진 벡터와 같다", () => {
  // SHA256(SHA256("")) — 비트코인 문서에 널리 실린 값
  assert.strictEqual(
    S.sha256dHex(Buffer.alloc(0)),
    "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456"
  );
  // SHA256(SHA256("hello"))
  assert.strictEqual(
    S.sha256dHex(Buffer.from("hello")),
    "9595c9df90075148eb06860365df33584b75bff782a510c6cd4883a419833d50"
  );
});

/* ------------------------------------------- secp256k1 */

const G_UNCOMPRESSED =
  "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

test("개인키 1 의 공개키는 생성점 G 다", () => {
  assert.strictEqual(Keys.getPublicKey("0".repeat(63) + "1"), G_UNCOMPRESSED);
  assert.strictEqual(
    Keys.compressPublicKey(G_UNCOMPRESSED),
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
  );
});

test("개인키는 1 이상 n 미만이어야 한다", () => {
  assert.strictEqual(Keys.isValidPrivateKey("0".repeat(64)), false);
  assert.strictEqual(Keys.isValidPrivateKey(Keys.bigIntToHex(Keys.CURVE_ORDER, 32)), false);
  assert.strictEqual(Keys.isValidPrivateKey(Keys.bigIntToHex(Keys.CURVE_ORDER - 1n, 32)), true);
  assert.strictEqual(Keys.isValidPrivateKey("abc"), false);
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(Keys.isValidPrivateKey(Keys.generatePrivateKey()), true);
  }
});

test("서명은 검증되고, 다른 메시지·다른 키·망가진 서명은 거부된다", () => {
  const priv = Keys.generatePrivateKey();
  const pub = Keys.getPublicKey(priv);
  const msg = S.sha256dHex(Buffer.from("txid"));
  const sig = Keys.sign(priv, msg);

  assert.strictEqual(Keys.verify(pub, msg, sig), true);
  assert.strictEqual(Keys.verify(pub, S.sha256dHex(Buffer.from("other")), sig), false);
  assert.strictEqual(Keys.verify(Keys.getPublicKey(Keys.generatePrivateKey()), msg, sig), false);
  assert.strictEqual(Keys.verify(pub, msg, sig.slice(0, -2) + "00"), false);
  assert.strictEqual(Keys.verify(pub, msg, "zz"), false);
  assert.strictEqual(Keys.verify("04" + "0".repeat(128), msg, sig), false, "곡선 위의 점이 아니다");
});

test("서명은 항상 low-S 이고, high-S 로 바꾼 같은 서명은 거부된다", () => {
  /*
   * ECDSA 는 (r, s) 와 (r, n-s) 가 둘 다 유효하다. 하나만 받아야 서명이
   * 밖에서 바뀌어 돌아다니지 못한다 (비트코인 BIP62/BIP146).
   */
  const priv = Keys.generatePrivateKey();
  const pub = Keys.getPublicKey(priv);
  const msg = S.sha256dHex(Buffer.from("malleable"));
  for (let i = 0; i < 8; i++) {
    const sig = Keys.sign(priv, msg);
    assert.strictEqual(Keys.isLowS(sig), true);
    const { r, s } = Keys.parseDer(sig);
    // n - s 로 바꾼 것: 수학적으로는 유효하지만 우리는 받지 않는다
    const highS = Keys.normalizeLowS.length === 1 && (() => {
      const flipped = Keys.CURVE_ORDER - s;
      // encodeDer 는 노출하지 않으므로 normalizeLowS 의 역을 직접 만든다
      const toDer = v => { let h = v.toString(16); if (h.length % 2) h = "0" + h; let b = Buffer.from(h, "hex"); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]); };
      const body = Buffer.concat([toDer(r), toDer(flipped)]);
      return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString("hex");
    })();
    assert.strictEqual(Keys.isLowS(highS), false);
    assert.strictEqual(Keys.verify(pub, msg, highS), false, "high-S 는 거부");
    assert.strictEqual(Keys.verify(pub, msg, Keys.normalizeLowS(highS)), true, "정규화하면 다시 유효");
  }
});

/* ------------------------------------------- 주소 */

test("Base58Check 주소는 비트코인 벡터와 같다 (버전 0x00)", () => {
  // 비트코인 위키 "Technical background of version 1 Bitcoin addresses"
  const pub =
    "0450863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352" +
    "2cd470243453a299fa9e77237716103abc11a1df38855ed6f2ee187e9c582ba6";
  assert.strictEqual(Address.addressFromPublicKey(pub, 0x00), "16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM");
  assert.strictEqual(
    Address.hash160(Buffer.from(pub, "hex")).toString("hex"),
    "010966776006953d5567439e5e39f86a0d273bee"
  );
});

test("메인넷 주소는 L, 테스트넷 주소는 m/n 으로 시작하고 서로 섞이지 않는다", () => {
  const pub = Keys.getPublicKey(Keys.generatePrivateKey());
  const main = Address.addressFromPublicKey(pub, 0x30);
  const testnet = Address.addressFromPublicKey(pub, 0x6f);

  assert.ok(main.startsWith("L"), main);
  assert.ok(/^[mn]/.test(testnet), testnet);
  assert.strictEqual(Address.isBase58Address(main, 0x30), true);
  assert.strictEqual(Address.isBase58Address(main, 0x6f), false, "메인넷 주소는 테스트넷에서 무효");
  assert.strictEqual(Address.isBase58Address(testnet, 0x30), false);
  assert.strictEqual(Address.addressMatchesPublicKey(main, pub, 0x30), true);
  assert.strictEqual(Address.addressMatchesPublicKey(main, Keys.getPublicKey(Keys.generatePrivateKey()), 0x30), false);
});

test("한 글자만 틀려도 주소가 아니다 (체크섬)", () => {
  const pub = Keys.getPublicKey(Keys.generatePrivateKey());
  const main = Address.addressFromPublicKey(pub, 0x30);
  for (let i = 1; i < main.length; i++) {
    const ch = main[i] === "1" ? "2" : "1";
    const typo = main.slice(0, i) + ch + main.slice(i + 1);
    assert.strictEqual(Address.isBase58Address(typo, 0x30), false, `자리 ${i}`);
  }
  // 예전 형식(공개키 hex)은 여전히 주소로 받는다
  assert.strictEqual(Address.isAddressValid(pub, 0x30), true);
  assert.strictEqual(Address.isLegacyAddress(pub), true);
  assert.strictEqual(Address.isLegacyAddress(main), false);
});

test("Base58 은 앞의 0 바이트를 '1' 로 보존한다", () => {
  const bytes = Buffer.from("0000ff", "hex");
  const encoded = Address.base58Encode(bytes);
  assert.ok(encoded.startsWith("11"));
  assert.deepStrictEqual(Address.base58Decode(encoded), bytes);
  assert.strictEqual(Address.base58CheckDecode("not*base58"), null);
});

/* ------------------------------------------- 직렬화 */

test("varint 는 CompactSize 규격이다", () => {
  assert.strictEqual(S.writeVarint(0).toString("hex"), "00");
  assert.strictEqual(S.writeVarint(252).toString("hex"), "fc");
  assert.strictEqual(S.writeVarint(253).toString("hex"), "fdfd00");
  assert.strictEqual(S.writeVarint(65535).toString("hex"), "fdffff");
  assert.strictEqual(S.writeVarint(65536).toString("hex"), "fe00000100");
  assert.strictEqual(S.writeVarint(2 ** 32).toString("hex"), "ff0000000001000000");
});

test("트랜잭션 직렬화는 정해진 바이트 배열이고 서명·공개키는 들어가지 않는다", () => {
  const tx = {
    txIns: [{ txOutId: "ab".repeat(32), txOutIndex: 1, signature: "3044...", publicKey: "04..." }],
    txOuts: [{ address: "LimAddr", amount: 1000 }]
  };
  const bytes = S.serializeTx(tx);
  const expected =
    "01" +                       // 입력 1개
    "ab".repeat(32) + "01000000" + // txOutId, index=1 (LE)
    "01" +                       // 출력 1개
    "07" + Buffer.from("LimAddr").toString("hex") + // varstr 주소
    "e803000000000000";          // 1000 (uint64 LE)
  assert.strictEqual(bytes.toString("hex"), expected);
  const stripped = { txIns: [{ txOutId: "ab".repeat(32), txOutIndex: 1 }], txOuts: tx.txOuts };
  assert.strictEqual(S.txIdOf(tx), S.txIdOf(stripped), "서명과 공개키는 id 에 영향이 없다");
});

test("코인베이스의 빈 txOutId 는 0 32바이트로 직렬화된다", () => {
  const cb = { txIns: [{ txOutId: "", txOutIndex: 7 }], txOuts: [{ address: "a", amount: 1 }] };
  assert.ok(S.serializeTx(cb).toString("hex").startsWith("01" + "00".repeat(32) + "07000000"));
});

test("블록 헤더는 84바이트다", () => {
  const header = {
    index: 5, previousHash: "11".repeat(32), timestamp: 1700000000,
    merkleRoot: "22".repeat(32), difficulty: 15, nonce: 2 ** 40
  };
  const bytes = S.serializeHeader(header);
  assert.strictEqual(bytes.length, 84);
  assert.strictEqual(bytes.readUInt32LE(0), 5);
  assert.strictEqual(bytes.subarray(4, 36).toString("hex"), "11".repeat(32));
  assert.strictEqual(bytes.readUInt32LE(36), 1700000000);
  assert.strictEqual(Number(bytes.readBigUInt64LE(76)), 2 ** 40, "nonce 는 uint64 — 채굴 중 2^32 를 넘을 수 있다");
  assert.strictEqual(S.blockHashOf(header), S.sha256dHex(bytes));
});

test("직렬화는 범위를 벗어난 값을 거부한다", () => {
  assert.throws(() => S.writeUInt32(-1), /uint32/);
  assert.throws(() => S.writeUInt32(2 ** 32), /uint32/);
  assert.throws(() => S.writeUInt64(1.5), /uint64/);
  assert.throws(() => S.writeHash("short"), /32바이트/);
});

/* ------------------------------------------- 작업증명 / 머클 */

test("앞자리 0 비트 세기", () => {
  assert.strictEqual(leadingZeroBits("ffff"), 0);
  assert.strictEqual(leadingZeroBits("7fff"), 1);
  assert.strictEqual(leadingZeroBits("3fff"), 2);
  assert.strictEqual(leadingZeroBits("1fff"), 3);
  assert.strictEqual(leadingZeroBits("0fff"), 4);
  assert.strictEqual(leadingZeroBits("00ff"), 8);
  assert.strictEqual(leadingZeroBits("0001"), 15);
  assert.strictEqual(hashMatchesDifficulty("0001" + "f".repeat(60), 15), true);
  assert.strictEqual(hashMatchesDifficulty("0001" + "f".repeat(60), 16), false);
});

test("머클 루트는 잎이 하나면 그 자체, 둘이면 sha256d(왼쪽||오른쪽) 다", () => {
  const a = "aa".repeat(32);
  const b = "bb".repeat(32);
  assert.strictEqual(getMerkleRoot([{ id: a }]), a);
  assert.strictEqual(
    getMerkleRoot([{ id: a }, { id: b }]),
    S.sha256dHex(Buffer.concat([Buffer.from(a, "hex"), Buffer.from(b, "hex")]))
  );
});
