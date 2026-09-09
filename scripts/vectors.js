/**
 * 합의 테스트 벡터를 만든다.
 *
 *   node scripts/vectors.js            # docs/vectors.json 을 다시 쓴다
 *   node scripts/vectors.js --check    # 지금 코드가 같은 값을 내는지 확인만
 *
 * 왜 필요한가. 이 체인은 구현이 하나뿐이고, 그래서 "이 구현이 하는 것"이 곧
 * 규칙이다. 다른 언어로 만드는 사람은 SPEC.md 를 읽고 짜겠지만 문서는 늘
 * 애매한 데가 남는다 — 스크립트 숫자의 최소 표기, varint 경계, 목표값 압축의
 * 가수 처리 같은 것.
 *
 * 그래서 입력과 답을 짝지어 파일 하나에 박아 둔다. 새 구현은 이 파일만
 * 통과시키면 적어도 여기 적힌 자리에서는 갈라지지 않는다. 우리 쪽도
 * 마찬가지다 — 리팩터링이 합의를 바꿔 버리면 --check 가 잡는다.
 *
 * 값은 전부 코드에서 뽑는다. 손으로 적으면 그게 또 틀린다.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const S = require("../src/serialization");
const Keys = require("../src/keys");
const Address = require("../src/address");
const Script = require("../src/script");
const Target = require("../src/target");
const Merkle = require("../src/merkle");
const Units = require("../src/units");
const Transactions = require("../src/transactions");

const OUT = path.join(__dirname, "..", "docs", "vectors.json");

// 씨앗에서 뽑은 개인키 — 난수를 쓰면 매번 파일이 바뀐다
const keyFrom = label => {
  let bytes = crypto.createHash("sha256").update(`limcoin-vector:${label}`).digest();
  while (!Keys.isValidPrivateKey(bytes.toString("hex"))) {
    bytes = crypto.createHash("sha256").update(bytes).digest();
  }
  return bytes.toString("hex");
};

const MAINNET = 0x30;
const TESTNET = 0x6f;
const MAINNET_SCRIPT = 0x32;
const TESTNET_SCRIPT = 0xc4;

/* ------------------------------------------- 1. 키와 주소 */

const keyVectors = () =>
  ["alice", "bob", "carol"].map(label => {
    const privateKey = keyFrom(label);
    const publicKey = Keys.getPublicKey(privateKey);
    return {
      label,
      privateKey,
      publicKey,
      compressed: Keys.compressPublicKey(publicKey),
      hash160: Address.hash160(Buffer.from(publicKey, "hex")).toString("hex"),
      mainnet: Address.addressFromPublicKey(publicKey, MAINNET),
      testnet: Address.addressFromPublicKey(publicKey, TESTNET)
    };
  });

const base58Vectors = () =>
  ["00", "ff", "0001", "000000", "6f" + "ab".repeat(20), "30" + "00".repeat(20)].map(hex => ({
    payloadHex: hex,
    encoded: Address.base58CheckEncode(Buffer.from(hex, "hex"))
  }));

/* ------------------------------------------- 2. 스크립트와 P2SH */

const scriptVectors = () => {
  const keys = ["alice", "bob", "carol"].map(keyFrom);
  const pubs = keys.map(Keys.getPublicKey);

  const multisig = Script.multisig(2, pubs);
  const timelock = Script.timeLocked(500000, pubs[0]);
  const secret = crypto.createHash("sha256").update("limcoin-vector:secret").digest("hex");
  const htlc = Script.hashTimeLocked({
    hash: crypto.createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex"),
    receiverPublicKey: pubs[0],
    senderPublicKey: pubs[1],
    lockTime: 500000
  });

  return [
    { name: "2-of-3 multisig", redeemScript: multisig },
    { name: "CLTV timelock", redeemScript: timelock },
    { name: "HTLC", redeemScript: htlc }
  ].map(entry => ({
    ...entry,
    asm: Script.toAsm(entry.redeemScript),
    mainnetAddress: Address.addressFromScript(entry.redeemScript, MAINNET_SCRIPT),
    testnetAddress: Address.addressFromScript(entry.redeemScript, TESTNET_SCRIPT)
  }));
};

// 스크립트 숫자는 최소 길이 리틀엔디언 + 부호 비트. 여기서 자주 갈라진다.
const scriptNumVectors = () =>
  [0, 1, -1, 16, 127, -127, 128, -128, 255, -255, 256, 32767, -32768, 500000, -500000, 2147483647]
    .map(value => ({ value, hex: Script.encodeNum(value).toString("hex") }));

/* ------------------------------------------- 3. 서명

 * ECDSA 는 k 를 난수로 뽑으므로 "이 키로 이 메시지를 서명하면 이 바이트"를
 * 벡터로 박을 수 없다 — 돌릴 때마다 달라진다. 대신 **확인**하는 쪽을 박는다.
 * 아래 서명은 한 번 만들어 고정한 것이고, 어떤 구현이든 low-S 는 받고
 * high-S 짝은 거부해야 한다.
 */

// 한 번 만들어 박아 둔 값. 다시 만들지 않는다 (만들면 달라진다).
const SIGNATURE_VECTOR = {
  privateKey: "471be454920bade099dbcb912de68f81e9ce69e68eb06d6e6b828eca66b97a0e",
  publicKey:
    "04c571a5c8b8bd439198c204123c87c71831761d8bfd3d8d25d5baa8fb7f504c59d8ef81f60f3f61e54dbeb9b6345d53d33da98bf5c5146ddacc9be866d0f28180",
  message: "4b9480f6f8ac498bfcc4869d25f01c8044d78b09c45c86e1ecc7e1d5b84afb4f",
  signatureLowS:
    "30440220202f3e961d92ada4751d57918dba12222cb02b88ff03c020efb9dc0746d3f6ee02201cf9d7ea200ff98ed10ac5483a6c3d0a071b2f919eaf3631297bbc1e8c7ad707",
  // 같은 (r, s) 에서 s 를 n-s 로 바꾼 것 — 수학적으로는 유효하지만 우리는 거부한다
  signatureHighS:
    "30450220202f3e961d92ada4751d57918dba12222cb02b88ff03c020efb9dc0746d3f6ee022100e3062815dff006712ef53ab7c593c2f4b393ad5510996a0a9656a26e43bb6a3a",
  lowSAccepted: true,
  highSRejected: true,
  note: "message 는 txid 다. 모든 입력이 같은 txid 에 서명한다 (SIGHASH_ALL 하나뿐)."
};

/* ------------------------------------------- 4. 직렬화와 txid */

const txVectors = () => {
  const alice = keyFrom("alice");
  const alicePub = Keys.getPublicKey(alice);
  const aliceAddr = Address.addressFromPublicKey(alicePub, MAINNET);
  const bobAddr = Address.addressFromPublicKey(Keys.getPublicKey(keyFrom("bob")), MAINNET);
  const redeem = Script.multisig(2, [alicePub, Keys.getPublicKey(keyFrom("bob"))]);
  const p2shAddr = Address.addressFromScript(redeem, MAINNET_SCRIPT);

  const build = tx => {
    const id = S.txIdOf(tx);
    return { ...tx, id };
  };

  const cases = [
    {
      name: "코인베이스 (빈 txOutId, 높이가 txOutIndex)",
      tx: build({
        txIns: [{ txOutId: "", txOutIndex: 7, signature: "" }],
        txOuts: [{ address: aliceAddr, amount: 1000000000 }],
        lockTime: 0
      })
    },
    {
      name: "P2PKH 하나에서 둘로",
      tx: build({
        txIns: [{ txOutId: "ab".repeat(32), txOutIndex: 0, signature: "" }],
        txOuts: [
          { address: bobAddr, amount: 250000000 },
          { address: aliceAddr, amount: 749995000 }
        ],
        lockTime: 0
      })
    },
    {
      name: "lockTime 높이 모드",
      tx: build({
        txIns: [{ txOutId: "cd".repeat(32), txOutIndex: 3, signature: "" }],
        txOuts: [{ address: aliceAddr, amount: 1 }],
        lockTime: 499999999
      })
    },
    {
      name: "lockTime 시간 모드",
      tx: build({
        txIns: [{ txOutId: "cd".repeat(32), txOutIndex: 3, signature: "" }],
        txOuts: [{ address: aliceAddr, amount: 1 }],
        lockTime: 1800000000
      })
    },
    {
      name: "출력 253개 (varint 경계)",
      tx: build({
        txIns: [{ txOutId: "ef".repeat(32), txOutIndex: 0, signature: "" }],
        txOuts: Array.from({ length: 253 }, () => ({ address: p2shAddr, amount: 1000 })),
        lockTime: 0
      })
    }
  ];

  /*
   * raw 형식(SPEC 3.3)까지 보인다. 해제 데이터는 **고정 바이트**를 쓴다 —
   * 진짜 서명은 k 가 난수라 돌릴 때마다 달라져 벡터가 되지 못한다. 여기서
   * 보이려는 것은 바이트 배치이지 서명의 유효성이 아니다(그건 위 3절).
   * 그래도 txid 가 해제 데이터와 무관하다는 것은 이 값으로도 보인다.
   */
  const FAKE_SIG = "30440220" + "11".repeat(32) + "0220" + "22".repeat(32);
  return cases.map(entry => {
    const signed = JSON.parse(JSON.stringify(entry.tx));
    signed.txIns[0].signature = FAKE_SIG;
    if (entry.name.startsWith("P2PKH")) {
      signed.txIns[0].publicKey = alicePub;
    }
    if (entry.name.startsWith("출력 253")) {
      signed.txIns[0].redeemScript = redeem;
      signed.txIns[0].unlock = ["", FAKE_SIG, FAKE_SIG];
    }
    return {
      name: entry.name,
      tx: entry.tx,
      // txid 미리보기 (SPEC 3.1) — 해제 데이터가 들어가지 않는다
      serializedHex: S.serializeTx(entry.tx).toString("hex"),
      txid: entry.tx.id,
      size: Transactions.getTxSize(signed),
      // raw 형식 (SPEC 3.3) — 해제 데이터까지
      rawHex: S.encodeTx(signed),
      // 서명이 붙어도 txid 는 그대로다
      txidAfterSigning: S.txIdOf(signed)
    };
  });
};

/* ------------------------------------------- 5. 블록 */

const headerVectors = () => {
  const genesisFiles = ["genesis.json", "genesis.testnet.json"];
  return genesisFiles.map(file => {
    const block = require(path.join("..", "src", file));
    return {
      name: file,
      header: {
        version: block.version,
        index: block.index,
        previousHash: block.previousHash,
        timestamp: block.timestamp,
        merkleRoot: block.merkleRoot,
        bits: block.bits,
        nonce: block.nonce
      },
      headerHex: S.serializeHeader(block).toString("hex"),
      hash: S.blockHashOf(block),
      merkleRootFromTxs: Merkle.getMerkleRoot(block.data),
      rawBlockHex: S.encodeBlock(block)
    };
  });
};

const merkleVectors = () => {
  const idOf = i => crypto.createHash("sha256").update(`limcoin-vector:tx${i}`).digest("hex");
  return [1, 2, 3, 4, 5, 7, 8, 9].map(n => {
    const txs = Array.from({ length: n }, (unused, i) => ({ id: idOf(i) }));
    return {
      count: n,
      txids: txs.map(tx => tx.id),
      root: Merkle.getMerkleRoot(txs),
      // 첫 잎의 증명 — 홀수 층에서 자기 자신과 짝짓는지 확인용
      proofOfFirst: Merkle.getMerkleProof(txs, txs[0].id)
    };
  });
};

/* ------------------------------------------- 6. 목표값과 난이도 */

const targetVectors = () => {
  const samples = [
    Target.POW_LIMIT_BITS,
    0x1d00ffff, // 비트코인 제네시스
    0x1b0404cb, // 비트코인 블록 100,000 언저리
    0x03000001,
    0x04123456,
    0x207fffff
  ];
  return samples
    .filter(bits => Target.isValidBits(bits))
    .map(bits => ({
      bits: `0x${(bits >>> 0).toString(16).padStart(8, "0")}`,
      target: Target.targetHex(bits),
      work: Target.workOf(bits).toString(),
      difficulty: Target.difficultyOf(bits),
      roundTrip: `0x${Target.bitsFromTarget(Target.targetFromBits(bits)).toString(16).padStart(8, "0")}`
    }));
};

// LWMA — 창이 꽉 찬 체인을 만들어 다음 bits 를 뽑는다
const lwmaVectors = () => {
  const T = 10;
  const N = 60;
  const genesisBits = 0x1f00ffff;
  const make = (spacing, label) => {
    const chain = [];
    for (let i = 0; i <= N; i++) {
      chain.push({ index: i, timestamp: 1700000000 + i * spacing, bits: genesisBits });
    }
    return {
      label,
      T,
      N,
      spacing,
      inputBits: `0x${genesisBits.toString(16)}`,
      firstTimestamp: chain[0].timestamp,
      lastTimestamp: chain[chain.length - 1].timestamp,
      nextBits: `0x${Target.nextTargetBits(chain, { T, N, genesisBits }).toString(16).padStart(8, "0")}`
    };
  };
  return [make(10, "정속 — 그대로"), make(5, "두 배로 빠름 — 어려워진다"), make(40, "네 배로 느림 — 쉬워진다")];
};

/* ------------------------------------------- 7. 금액과 발행 */

const unitVectors = () => ({
  parse: ["0", "1", "0.00000001", "10", "21000000", "0.1", "1.23456789"].map(text => ({
    text,
    lm: Units.parseLim(text)
  })),
  format: [0, 1, 100000000, 1234567890, 1000000000000].map(lm => ({ lm, text: Units.formatLim(lm) })),
  subsidy: [0, 1, 209999, 210000, 419999, 420000, 6930000, 13230000].map(height => ({
    height,
    subsidy: Transactions.getBlockSubsidy(height)
  }))
});

/* ------------------------------------------- 모아서 쓰기 */

const build = () => ({
  note:
    "LimCoin 합의 테스트 벡터. 다른 구현은 이 값을 그대로 내야 한다. " +
    "scripts/vectors.js 가 만든다 — 손으로 고치지 말 것.",
  spec: "docs/SPEC.md",
  keys: keyVectors(),
  base58check: base58Vectors(),
  scripts: scriptVectors(),
  scriptNumbers: scriptNumVectors(),
  signature: SIGNATURE_VECTOR,
  transactions: txVectors(),
  blocks: headerVectors(),
  merkle: merkleVectors(),
  target: targetVectors(),
  lwma: lwmaVectors(),
  units: unitVectors()
});

const text = JSON.stringify(build(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  if (existing === text) {
    console.log(`벡터가 지금 코드와 같습니다: ${path.relative(process.cwd(), OUT)}`);
    process.exit(0);
  }
  console.error(
    existing === null
      ? `벡터 파일이 없습니다. node scripts/vectors.js 로 만드세요.`
      : `벡터가 달라졌습니다. 합의를 바꾼 것이 맞다면 node scripts/vectors.js 로 다시 쓰세요.`
  );
  process.exit(1);
}

fs.writeFileSync(OUT, text);
console.log(`${path.relative(process.cwd(), OUT)} 를 썼습니다 (${text.length} 바이트)`);
