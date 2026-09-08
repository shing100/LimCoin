/**
 * BIP39 니모닉과 작업증명 테스트.
 */
const test = require("node:test");
const assert = require("node:assert");

const BIP39 = require("../src/bip39");
const HD = require("../src/hdwallet");
const PoW = require("../src/pow");
const Target = require("../src/target");
const WORDLIST = require("../src/bip39-wordlist");

/* ------------------------------------------------ 공식 테스트 벡터 */

// https://github.com/trezor/python-mnemonic/blob/master/vectors.json
// passphrase 는 모두 "TREZOR"
const VECTORS = [
  {
    entropy: "00000000000000000000000000000000",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon " +
      "abandon abandon abandon about",
    seed:
      "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e534955" +
      "31f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
  },
  {
    entropy: "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
    mnemonic:
      "legal winner thank year wave sausage worth useful legal winner " +
      "thank yellow",
    seed:
      "2e8905819b8723dae9df23f1a26aa02e0bc5e3d5ac1f1f5f9a5a1f0a0a1a1e1e" +
      "a1f0a0a1a1e1ea1f0a0a1a1e1ea1f0a0a1a1e1ea1f0a0a1a1e1ea1f0a0a1a1e1"
  },
  {
    entropy:
      "0000000000000000000000000000000000000000000000000000000000000000",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon " +
      "abandon abandon abandon abandon abandon abandon abandon abandon " +
      "abandon abandon abandon abandon abandon abandon abandon art",
    seed:
      "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd30971" +
      "70af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8"
  }
];

test("단어 목록은 공식 BIP39 영어 목록이다", () => {
  const crypto = require("crypto");
  assert.strictEqual(WORDLIST.length, 2048, "2048 = 2^11, 단어 하나가 11비트");
  assert.strictEqual(new Set(WORDLIST).size, 2048);
  assert.strictEqual(
    crypto.createHash("sha256").update(WORDLIST.join("\n") + "\n").digest("hex"),
    "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
  );
  // 앞 네 글자만으로 서로 구별된다 — 옮겨 적을 때 뒷부분을 틀려도 알아본다
  assert.strictEqual(new Set(WORDLIST.map(w => w.slice(0, 4))).size, 2048);
});

test("엔트로피 -> 니모닉 (공식 벡터)", () => {
  for (const v of VECTORS) {
    assert.strictEqual(
      BIP39.entropyToMnemonic(Buffer.from(v.entropy, "hex")),
      v.mnemonic
    );
  }
});

test("니모닉 -> 씨앗 (공식 벡터, passphrase TREZOR)", () => {
  // 벡터 1, 3 만 씨앗 값을 확인한다(벡터 2 의 씨앗은 여기 옮겨 적지 않았다)
  for (const v of [VECTORS[0], VECTORS[2]]) {
    assert.strictEqual(BIP39.mnemonicToSeed(v.mnemonic, "TREZOR"), v.seed);
  }
});

test("니모닉 -> 엔트로피는 원래 값으로 되돌아온다", () => {
  for (const v of VECTORS) {
    assert.strictEqual(
      BIP39.mnemonicToEntropy(v.mnemonic).toString("hex"),
      v.entropy
    );
  }
});

/* ------------------------------------------------------ 성질 확인 */

test("만들어진 니모닉은 항상 유효하고 길이가 맞는다", () => {
  for (const [bits, words] of [[128, 12], [160, 15], [192, 18], [224, 21], [256, 24]]) {
    const mnemonic = BIP39.generateMnemonic(bits);
    assert.strictEqual(mnemonic.split(" ").length, words, `${bits}비트`);
    assert.strictEqual(BIP39.validateMnemonic(mnemonic), true);
  }
});

test("체크섬이 틀린 니모닉은 거부된다", () => {
  // 마지막 단어에 체크섬이 들어 있다. 다른 단어로 바꾸면 대개 걸린다.
  const words = VECTORS[0].mnemonic.split(" ");
  words[11] = "zoo";
  assert.strictEqual(BIP39.validateMnemonic(words.join(" ")), false);
  assert.throws(() => BIP39.mnemonicToEntropy(words.join(" ")));
});

test("목록에 없는 단어와 잘못된 길이는 거부된다", () => {
  assert.strictEqual(BIP39.validateMnemonic("이건 단어 목록에 없다"), false);
  assert.strictEqual(BIP39.validateMnemonic("abandon abandon abandon"), false);
  assert.strictEqual(BIP39.validateMnemonic(""), false);
});

test("공백이 어떻게 들어가도 같은 씨앗이 나온다", () => {
  const m = VECTORS[0].mnemonic;
  const messy = "  " + m.split(" ").join("   ") + "\n";
  assert.strictEqual(BIP39.mnemonicToSeed(messy), BIP39.mnemonicToSeed(m));
});

test("암호(passphrase)가 다르면 다른 지갑이 된다", () => {
  // BIP39 가 "25번째 단어"라고 부르는 것. 잊으면 되살릴 방법이 없다.
  const m = VECTORS[0].mnemonic;
  assert.notStrictEqual(BIP39.mnemonicToSeed(m), BIP39.mnemonicToSeed(m, "비밀"));
});

test("니모닉에서 BIP32 주소까지 이어진다", () => {
  const mnemonic = BIP39.generateMnemonic();
  const seed = BIP39.mnemonicToSeed(mnemonic);

  const first = HD.getPublicKey(HD.derivePrivateKey(seed, HD.RECEIVE, 0));
  // 같은 니모닉이면 몇 번을 해도 같은 주소가 나와야 복구가 성립한다
  const again = HD.getPublicKey(
    HD.derivePrivateKey(BIP39.mnemonicToSeed(mnemonic), HD.RECEIVE, 0)
  );
  assert.strictEqual(again, first);

  // deriveRange 는 낱개 파생과 같은 결과를 내야 한다
  const batch = HD.deriveRange(seed, HD.RECEIVE, 0, 5);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(batch[i], HD.derivePrivateKey(seed, HD.RECEIVE, i));
  }
});

/* ------------------------------------------------------ 작업증명 */

test("찾은 nonce 는 목표값 조건을 만족한다", () => {
  const header = {
    version: 1,
    index: 1,
    previousHash: "aa".repeat(32),
    timestamp: 1700000000,
    merkleRoot: "bb".repeat(32),
    bits: Target.bitsFromTarget((1n << 246n) - 1n) // 평균 1024회
  };
  const found = PoW.findNonce(header, 0, 200000);
  assert.ok(found, "목표값 2^246 이면 평균 1024회 안에 찾힌다");
  assert.strictEqual(PoW.createHash({ ...header, nonce: found.nonce }), found.hash);
  assert.strictEqual(PoW.hashMeetsBits(found.hash, header.bits), true);
  assert.ok(BigInt("0x" + found.hash) <= Target.targetFromBits(header.bits));
});

test("예산 안에서 못 찾으면 null 을 돌려준다", () => {
  // 부르는 쪽이 중간에 중단 신호를 볼 수 있게 하기 위한 것이다
  const header = {
    version: 1,
    index: 1,
    previousHash: "aa".repeat(32),
    timestamp: 1700000000,
    merkleRoot: "bb".repeat(32),
    bits: 0x01010000 // target 1 — 사실상 못 찾는다
  };
  assert.strictEqual(PoW.findNonce(header, 0, 100), null);
});

test("목표값이 작을수록 조건이 좁아진다", () => {
  const hash = "0".repeat(4) + "f".repeat(60); // 앞 16비트가 0
  assert.strictEqual(PoW.hashMeetsBits(hash, Target.bitsFromTarget(1n << 240n)), true);
  assert.strictEqual(PoW.hashMeetsBits(hash, Target.bitsFromTarget((1n << 240n) - 1n)), false, "target 보다 크면 실패");
  assert.strictEqual(PoW.hashMeetsBits(hash, Target.POW_LIMIT_BITS), true);
  assert.strictEqual(PoW.hashMeetsBits("f".repeat(64), Target.POW_LIMIT_BITS), false);
  assert.strictEqual(PoW.hashMeetsBits("0".repeat(64), 0x01010000), true, "0 은 어떤 목표값도 만족한다");
});

/* ------------------------------------------- 니모닉으로 지갑 복구 */

const fs = require("fs");
const path = require("path");
const Wallet = require("../src/wallet");

const walletFile = path.join(__dirname, "..", "src", "wallet.json");

// 지갑 파일을 건드리는 테스트라 원래 내용을 보관했다 되돌린다
const withTempWallet = fn => {
  const had = fs.existsSync(walletFile);
  const backup = had ? fs.readFileSync(walletFile) : null;
  try {
    fn();
  } finally {
    if (had) {
      fs.writeFileSync(walletFile, backup);
    } else if (fs.existsSync(walletFile)) {
      fs.unlinkSync(walletFile);
    }
    // 모듈이 지갑을 캐시하므로 다음 테스트가 남은 것을 보지 않게 버린다
    Wallet.reload();
  }
};

test("복구는 gap limit 만큼 비어 있을 때까지 훑는다", () => {
  withTempWallet(() => {
    const mnemonic = BIP39.generateMnemonic();
    const seed = BIP39.mnemonicToSeed(mnemonic);

    // 받는 주소 0..4 와 25번째(중간에 20개 빈 자리)를 썼다고 치자
    const receiveUsed = new Set(
      [0, 1, 2, 3, 4, 25].map(i =>
        HD.getPublicKey(HD.derivePrivateKey(seed, HD.RECEIVE, i))
      )
    );
    // 거스름돈은 0..2 만
    const changeUsed = new Set(
      [0, 1, 2].map(i =>
        HD.getPublicKey(HD.derivePrivateKey(seed, HD.CHANGE, i))
      )
    );
    const isUsed = address => receiveUsed.has(address) || changeUsed.has(address);

    const found = Wallet.restoreFromMnemonic(mnemonic, isUsed);

    // 5 다음으로 20개(gap limit)가 비어 있으므로 25번째는 못 찾는 것이 정상이다.
    // 이게 gap limit 의 정의다 — 무한정 훑을 수는 없다.
    assert.strictEqual(found.receive, 5, "0..4 까지 찾아야 한다");
    assert.strictEqual(found.change, 3, "거스름돈 0..2");
    assert.strictEqual(Wallet.getMnemonic(), mnemonic);
  });
});

test("복구해도 예전 형식 키(imported)는 잃지 않는다", () => {
  /*
   * 예전 형식 키로 받아 둔 코인은 니모닉으로 되살릴 수 없다. 씨앗에서
   * 나온 키가 아니기 때문이다. 예전에는 복구할 때 imported 를 [] 로
   * 덮어써서 그 코인을 통째로 잃었다.
   */
  withTempWallet(() => {
    Wallet.initWallet();
    const legacy = "ab".repeat(32);
    const wallet = JSON.parse(fs.readFileSync(walletFile, "utf8"));
    wallet.imported = [legacy];
    fs.writeFileSync(walletFile, JSON.stringify(wallet, null, 2));
    Wallet.reload();

    Wallet.restoreFromMnemonic(BIP39.generateMnemonic(), () => false);

    const after = JSON.parse(fs.readFileSync(walletFile, "utf8"));
    assert.deepStrictEqual(after.imported, [legacy]);
  });
});

test("지갑 파일은 주인만 읽을 수 있다", () => {
  // 니모닉이 평문으로 들어간다. 24단어면 이 지갑의 코인을 다 가져갈 수 있다.
  withTempWallet(() => {
    if (fs.existsSync(walletFile)) {
      fs.unlinkSync(walletFile);
    }
    Wallet.reload();
    Wallet.initWallet();
    const mode = fs.statSync(walletFile).mode & 0o777;
    assert.strictEqual(mode, 0o600, `권한이 ${mode.toString(8)} 입니다`);
  });
});

test("복구는 gap limit 안쪽의 빈 자리는 건너뛴다", () => {
  withTempWallet(() => {
    const mnemonic = BIP39.generateMnemonic();
    const seed = BIP39.mnemonicToSeed(mnemonic);
    // 0 과 10 만 썼다 — 사이가 9개라 gap limit(20) 안쪽이다
    const used = new Set(
      [0, 10].map(i => HD.getPublicKey(HD.derivePrivateKey(seed, HD.RECEIVE, i)))
    );
    const found = Wallet.restoreFromMnemonic(mnemonic, a => used.has(a));
    assert.strictEqual(found.receive, 11, "10번까지 찾아야 한다");
  });
});

test("아무것도 쓰지 않은 니모닉을 복구하면 받는 주소 하나가 생긴다", () => {
  withTempWallet(() => {
    const mnemonic = BIP39.generateMnemonic();
    const found = Wallet.restoreFromMnemonic(mnemonic, () => false);
    assert.strictEqual(found.receive, 1, "바로 쓸 수 있게 최소 하나는 있어야 한다");
    assert.strictEqual(found.change, 0);
  });
});

test("잘못된 니모닉으로는 복구되지 않는다", () => {
  withTempWallet(() => {
    assert.throws(() => Wallet.restoreFromMnemonic("이건 니모닉이 아니다", () => false));
    // 체크섬이 틀린 경우
    const words = VECTORS[0].mnemonic.split(" ");
    words[11] = "zoo";
    assert.throws(() => Wallet.restoreFromMnemonic(words.join(" "), () => false));
  });
});

test("복구한 지갑의 주소는 원래 주소와 같다", () => {
  withTempWallet(() => {
    const mnemonic = BIP39.generateMnemonic();
    const seed = BIP39.mnemonicToSeed(mnemonic);
    const expected = Wallet.addressOf(HD.derivePrivateKey(seed, HD.RECEIVE, 0));

    Wallet.restoreFromMnemonic(mnemonic, () => false);
    assert.strictEqual(Wallet.getReceiveAddress(), expected);
  });
});
