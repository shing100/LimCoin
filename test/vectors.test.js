/**
 * 합의 테스트 벡터.
 *
 * docs/vectors.json 은 "이 입력이면 이 답"을 박아 둔 파일이다. 다른 언어로
 * 만드는 사람이 맞춰 볼 것이고, 우리 쪽에서는 **리팩터링이 합의를 바꿔
 * 버렸는지**를 잡는다.
 *
 * 여기서 값이 어긋났다면 둘 중 하나다.
 *   - 실수로 규칙을 바꿨다 → 코드를 고친다
 *   - 일부러 바꿨다 → node scripts/vectors.js 로 파일을 다시 쓰고,
 *     그것이 하드포크라는 것을 알고 있어야 한다
 */
const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const path = require("path");

const vectors = require("../docs/vectors.json");
const S = require("../src/serialization");
const Keys = require("../src/keys");
const Address = require("../src/address");
const Script = require("../src/script");
const Target = require("../src/target");
const Merkle = require("../src/merkle");
const Units = require("../src/units");
const Transactions = require("../src/transactions");

test("생성기가 지금 코드로 같은 파일을 만든다", () => {
  // 아래 테스트들이 놓친 자리까지 통째로 비교한다
  assert.doesNotThrow(
    () =>
      execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "vectors.js"), "--check"], {
        stdio: "pipe"
      }),
    "docs/vectors.json 이 코드와 다르다 — node scripts/vectors.js 로 다시 쓰거나 코드를 고쳐라"
  );
});

test("키에서 주소가 나온다", () => {
  for (const v of vectors.keys) {
    assert.strictEqual(Keys.getPublicKey(v.privateKey), v.publicKey, v.label);
    assert.strictEqual(Keys.compressPublicKey(v.publicKey), v.compressed, v.label);
    assert.strictEqual(Address.hash160(Buffer.from(v.publicKey, "hex")).toString("hex"), v.hash160);
    assert.strictEqual(Address.addressFromPublicKey(v.publicKey, 0x30), v.mainnet);
    assert.strictEqual(Address.addressFromPublicKey(v.publicKey, 0x6f), v.testnet);
    assert.ok(v.mainnet.startsWith("L"), `메인넷 주소는 L 로 시작한다: ${v.mainnet}`);
  }
});

test("Base58Check 가 왕복한다", () => {
  for (const v of vectors.base58check) {
    const payload = Buffer.from(v.payloadHex, "hex");
    assert.strictEqual(Address.base58CheckEncode(payload), v.encoded, v.payloadHex);
    assert.deepStrictEqual(Address.base58CheckDecode(v.encoded), payload);
  }
});

test("스크립트와 P2SH 주소", () => {
  for (const v of vectors.scripts) {
    assert.strictEqual(Address.addressFromScript(v.redeemScript, 0x32), v.mainnetAddress, v.name);
    assert.strictEqual(Address.addressFromScript(v.redeemScript, 0xc4), v.testnetAddress, v.name);
    assert.strictEqual(Script.toAsm(v.redeemScript), v.asm, v.name);
    // 주소에서 스크립트 해시가 도로 나온다
    assert.strictEqual(
      Address.scriptMatchesAddress(v.mainnetAddress, v.redeemScript, 0x32),
      true,
      v.name
    );
  }
});

test("스크립트 숫자는 최소 길이 리틀엔디언이다", () => {
  for (const v of vectors.scriptNumbers) {
    assert.strictEqual(Script.encodeNum(v.value).toString("hex"), v.hex, `${v.value}`);
    assert.strictEqual(Script.decodeNum(Buffer.from(v.hex, "hex")), v.value, v.hex);
  }
});

test("서명은 low-S 만 받는다 (박아 둔 값)", () => {
  const v = vectors.signature;
  assert.strictEqual(Keys.getPublicKey(v.privateKey), v.publicKey);
  assert.strictEqual(Keys.verify(v.publicKey, v.message, v.signatureLowS), v.lowSAccepted);
  assert.strictEqual(Keys.isLowS(v.signatureLowS), true);
  assert.strictEqual(Keys.verify(v.publicKey, v.message, v.signatureHighS), !v.highSRejected);
  assert.strictEqual(Keys.isLowS(v.signatureHighS), false);

  // 같은 서명을 지금 만들면 바이트는 다르지만(k 가 난수) 확인은 통과해야 한다
  const fresh = Keys.sign(v.privateKey, v.message);
  assert.strictEqual(Keys.verify(v.publicKey, v.message, fresh), true);
  assert.strictEqual(Keys.isLowS(fresh), true);
});

test("트랜잭션 직렬화와 txid", () => {
  for (const v of vectors.transactions) {
    assert.strictEqual(S.serializeTx(v.tx).toString("hex"), v.serializedHex, v.name);
    assert.strictEqual(S.txIdOf(v.tx), v.txid, v.name);
    assert.strictEqual(Transactions.getTxId(v.tx), v.txid, v.name);

    // raw 를 되읽으면 같은 txid 가 나온다 — 서명이 붙어도 id 는 그대로다
    const decoded = S.decodeTx(v.rawHex);
    assert.strictEqual(decoded.id, v.txid, `${v.name}: raw 에서 되읽은 id`);
    assert.strictEqual(S.encodeTx(decoded), v.rawHex, `${v.name}: raw 왕복`);
    assert.strictEqual(v.txidAfterSigning, v.txid, `${v.name}: 서명이 id 를 바꿨다`);
  }
});

test("블록 헤더 88바이트와 해시", () => {
  for (const v of vectors.blocks) {
    const block = require(`../src/${v.name}`);
    assert.strictEqual(S.serializeHeader(block).toString("hex"), v.headerHex, v.name);
    assert.strictEqual(v.headerHex.length, 88 * 2, `${v.name}: 헤더는 88바이트다`);
    assert.strictEqual(S.blockHashOf(block), v.hash, v.name);
    assert.strictEqual(block.hash, v.hash, `${v.name}: 파일에 적힌 해시`);
    assert.strictEqual(Merkle.getMerkleRoot(block.data), v.merkleRootFromTxs, v.name);
    assert.strictEqual(block.merkleRoot, v.merkleRootFromTxs, `${v.name}: 파일에 적힌 머클 루트`);
    assert.strictEqual(S.decodeBlock(v.rawBlockHex).hash, v.hash, `${v.name}: raw 블록`);
  }
});

test("머클 루트와 증명", () => {
  for (const v of vectors.merkle) {
    const txs = v.txids.map(id => ({ id }));
    assert.strictEqual(Merkle.getMerkleRoot(txs), v.root, `${v.count}건`);
    assert.deepStrictEqual(Merkle.getMerkleProof(txs, v.txids[0]), v.proofOfFirst, `${v.count}건`);
    assert.strictEqual(Merkle.verifyMerkleProof(v.txids[0], v.proofOfFirst, v.root), true);
  }
});

test("압축 목표값, 일한 양, 난이도", () => {
  for (const v of vectors.target) {
    const bits = Number(v.bits);
    assert.strictEqual(Target.isValidBits(bits), true, v.bits);
    assert.strictEqual(Target.targetHex(bits), v.target, v.bits);
    assert.strictEqual(Target.workOf(bits).toString(), v.work, v.bits);
    assert.strictEqual(Target.difficultyOf(bits), v.difficulty, v.bits);
    assert.strictEqual(`0x${Target.bitsFromTarget(Target.targetFromBits(bits)).toString(16).padStart(8, "0")}`, v.roundTrip, v.bits);
  }
});

test("LWMA 가 정한 다음 목표값", () => {
  for (const v of vectors.lwma) {
    const genesisBits = Number(v.inputBits);
    const chain = [];
    for (let i = 0; i <= v.N; i++) {
      chain.push({ index: i, timestamp: v.firstTimestamp + i * v.spacing, bits: genesisBits });
    }
    assert.strictEqual(chain[chain.length - 1].timestamp, v.lastTimestamp, v.label);
    const next = Target.nextTargetBits(chain, { T: v.T, N: v.N, genesisBits });
    assert.strictEqual(`0x${next.toString(16).padStart(8, "0")}`, v.nextBits, v.label);
  }

  // 방향이 맞는지도 한 번 더 — 빠르면 어렵고, 느리면 쉽다
  const [steady, fast, slow] = vectors.lwma;
  assert.ok(Target.targetFromBits(Number(fast.nextBits)) < Target.targetFromBits(Number(steady.nextBits)));
  assert.ok(Target.targetFromBits(Number(slow.nextBits)) > Target.targetFromBits(Number(steady.nextBits)));
});

test("금액 표기와 발행량", () => {
  for (const v of vectors.units.parse) {
    assert.strictEqual(Units.parseLim(v.text), v.lm, v.text);
  }
  for (const v of vectors.units.format) {
    assert.strictEqual(Units.formatLim(v.lm), v.text, `${v.lm}`);
    assert.strictEqual(Units.parseLim(v.text), v.lm, `${v.text} 왕복`);
  }
  for (const v of vectors.units.subsidy) {
    assert.strictEqual(Transactions.getBlockSubsidy(v.height), v.subsidy, `높이 ${v.height}`);
  }
});
