/**
 * 계층 결정적(HD) 키 파생. BIP32 와 같은 방식이다.
 *
 * 백서 10장 "Privacy":
 *
 *   "As an additional firewall, a new key pair should be used for each
 *    transaction to keep them from being linked to a common owner."
 *
 * 지금까지 LimCoin 지갑은 개인키 하나를 만들어 영원히 재사용했다. 그러면
 * 그 주소에 얽힌 모든 거래가 한 사람의 것으로 묶여 버린다. 백서가 짚는
 * 바로 그 문제다.
 *
 * 트랜잭션마다 새 키를 쓰려면 키를 여러 개 관리해야 하는데, 그때마다
 * 새 난수 키를 만들면 백업할 것이 계속 늘어난다. BIP32 는 씨앗 하나에서
 * 필요한 만큼 키를 만들어 내는 것으로 이 문제를 푼다 — 백업할 것은 씨앗
 * 하나뿐이다.
 *
 * 여기서는 BIP32 의 강화되지 않은(non-hardened) 파생만 쓴다. 라이브러리를
 * 끌어오지 않고 Node 내장 crypto 의 HMAC-SHA512 로 충분히 구현된다.
 * (BIP39 니모닉은 2048단어 목록이 필요해 여기서는 다루지 않는다.
 *  씨앗을 16진수로 다룬다.)
 */
const crypto = require("crypto"),
  elliptic = require("elliptic"),
  BN = require("bn.js");

const ec = new elliptic.ec("secp256k1");
const CURVE_ORDER = ec.curve.n;

// BIP32 가 쓰는 문자열. 씨앗에서 마스터 키를 뽑을 때의 HMAC 키다.
const MASTER_KEY_SALT = "Bitcoin seed";

const SEED_BYTES = 32;

const hmac512 = (key, data) =>
  crypto.createHmac("sha512", key).update(data).digest();

const toHex32 = bn => bn.toString(16).padStart(64, "0");

const generateSeed = () => crypto.randomBytes(SEED_BYTES).toString("hex");

/**
 * 씨앗 -> 마스터 키. HMAC-SHA512 의 앞 32바이트가 개인키, 뒤 32바이트가
 * 체인 코드다.
 */
const masterFromSeed = seedHex => {
  const digest = hmac512(MASTER_KEY_SALT, Buffer.from(seedHex, "hex"));
  const key = new BN(digest.slice(0, 32));
  if (key.isZero() || key.gte(CURVE_ORDER)) {
    // 확률적으로 거의 일어나지 않지만 BIP32 가 정의한 처리다
    throw Error("이 씨앗으로는 키를 만들 수 없습니다. 다시 만드세요.");
  }
  return { key, chainCode: digest.slice(32) };
};

// 공개키를 33바이트 압축 형식으로. BIP32 의 serP() 에 해당한다.
const serializePoint = key => {
  const point = ec.g.mul(key);
  return Buffer.from(point.encode("array", true));
};

/**
 * 자식 키 하나를 파생한다 (강화되지 않은 파생).
 *
 *   I = HMAC-SHA512(chainCode, serP(point(k)) || index)
 *   자식키 = (I 앞 32바이트 + 부모키) mod n
 */
const deriveChild = (parent, index) => {
  const data = Buffer.concat([
    serializePoint(parent.key),
    Buffer.from([
      (index >>> 24) & 0xff,
      (index >>> 16) & 0xff,
      (index >>> 8) & 0xff,
      index & 0xff
    ])
  ]);

  const digest = hmac512(parent.chainCode, data);
  const tweak = new BN(digest.slice(0, 32));

  if (tweak.gte(CURVE_ORDER)) {
    // BIP32 는 이 경우 다음 index 로 넘어가라고 한다
    return deriveChild(parent, index + 1);
  }

  const key = tweak.add(parent.key).umod(CURVE_ORDER);
  if (key.isZero()) {
    return deriveChild(parent, index + 1);
  }

  return { key, chainCode: digest.slice(32) };
};

/*
 * 갈래를 둘로 나눈다 (BIP32/BIP44 의 external / internal chain).
 *
 *   m/0/i  받는 주소  — 남에게 알려 주는 주소
 *   m/1/i  거스름돈   — 내가 나에게 돌려받는 주소
 *
 * 나누지 않으면 거스름돈 주소가 곧 다음 받는 주소가 되어, 남에게 알려 준
 * 주소와 거스름돈이 같은 것이 된다. 그러면 주소를 새로 만드는 의미가 없다.
 */
const RECEIVE = 0;
const CHANGE = 1;

/**
 * 씨앗에서 m/branch/index 개인키를 뽑는다.
 */
const derivePrivateKey = (seedHex, branch, index) => {
  const master = masterFromSeed(seedHex);
  return toHex32(deriveChild(deriveChild(master, branch), index).key);
};

/**
 * 같은 갈래에서 여러 개를 뽑는다.
 * 마스터와 갈래 노드를 한 번만 파생하므로 낱개로 부르는 것보다 싸다.
 */
const deriveRange = (seedHex, branch, from, count) => {
  if (count <= 0) {
    return [];
  }
  const branchNode = deriveChild(masterFromSeed(seedHex), branch);
  const keys = [];
  for (let i = from; i < from + count; i++) {
    keys.push(toHex32(deriveChild(branchNode, i).key));
  }
  return keys;
};

const getPublicKey = privateKeyHex =>
  ec
    .keyFromPrivate(privateKeyHex, "hex")
    .getPublic()
    .encode("hex");

module.exports = {
  generateSeed,
  masterFromSeed,
  deriveChild,
  derivePrivateKey,
  deriveRange,
  getPublicKey,
  RECEIVE,
  CHANGE,
  SEED_BYTES
};
