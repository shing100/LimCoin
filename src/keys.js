/**
 * 키와 서명 — secp256k1 ECDSA.
 *
 * 예전에는 elliptic(서명)과 crypto-js(해시), bn.js(큰 수)를 썼다. 2018년의
 * 선택이고 elliptic 은 그 뒤 취약점 이력이 있다. 실제 자산이 걸린다면 검증된
 * 구현이어야 한다. Node 의 crypto 는 OpenSSL 이고 secp256k1 을 지원하므로
 * 의존성 없이 전부 바꿀 수 있다. 큰 수는 BigInt 로 충분하다.
 *
 * 형식
 *   개인키  32바이트 (hex 64자)
 *   공개키  비압축 65바이트 04||x||y (hex 130자). 압축 33바이트는 HD 파생에서만.
 *   서명    DER hex. S 는 항상 n/2 이하(low-S) — 같은 서명의 두 가지 표현이
 *           돌아다니지 못하게 한다(비트코인 BIP62/BIP146).
 *   서명 대상  32바이트 메시지(txid). ECDSA 는 그것을 SHA256 으로 한 번 더
 *           해시한 값 위에서 돈다.
 *
 * OpenSSL 의 ECDSA 는 nonce 를 무작위로 뽑으므로 같은 것을 두 번 서명하면
 * 바이트가 다르다. 유효성에는 상관없다.
 */
const crypto = require("crypto");

const CURVE = "secp256k1";
// 곡선의 차수 n. 개인키는 1..n-1, S 는 n/2 이하여야 한다.
const CURVE_ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const HALF_ORDER = CURVE_ORDER >> 1n;

const hexToBigInt = hex => BigInt("0x" + hex);
const bigIntToHex = (value, bytes) => value.toString(16).padStart(bytes * 2, "0");

const isValidPrivateKey = privHex =>
  typeof privHex === "string" &&
  /^[0-9a-fA-F]{64}$/.test(privHex) &&
  hexToBigInt(privHex) !== 0n &&
  hexToBigInt(privHex) < CURVE_ORDER;

// 1..n-1 사이의 무작위 개인키. 범위를 벗어나면 다시 뽑는다 (확률 2^-128 쯤).
const generatePrivateKey = () => {
  for (;;) {
    const candidate = crypto.randomBytes(32).toString("hex");
    if (isValidPrivateKey(candidate)) {
      return candidate;
    }
  }
};

// 개인키 -> 비압축 공개키 hex (04 || x || y)
const getPublicKey = privHex => {
  if (!isValidPrivateKey(privHex)) {
    throw Error("개인키가 올바르지 않습니다");
  }
  const ecdh = crypto.createECDH(CURVE);
  ecdh.setPrivateKey(privHex, "hex");
  return ecdh.getPublicKey("hex", "uncompressed");
};

// 비압축 <-> 압축 (BIP32 의 serP 는 압축 형식을 쓴다)
const compressPublicKey = pubHex => {
  const point = crypto.ECDH.convertKey(pubHex, CURVE, "hex", "hex", "compressed");
  return point;
};

const isValidPublicKey = pubHex => {
  if (typeof pubHex !== "string" || !/^04[0-9a-fA-F]{128}$/.test(pubHex)) {
    return false;
  }
  try {
    // 곡선 위의 점인지는 OpenSSL 이 확인한다
    crypto.ECDH.convertKey(pubHex, CURVE, "hex", "hex", "compressed");
    return true;
  } catch (e) {
    return false;
  }
};

/* ------------------------------------------- 키 객체 만들기 (JWK 경유) */

const base64url = buf => Buffer.from(buf).toString("base64url");

const jwkFromPublic = pubHex => ({
  kty: "EC",
  crv: CURVE,
  x: base64url(Buffer.from(pubHex.slice(2, 66), "hex")),
  y: base64url(Buffer.from(pubHex.slice(66, 130), "hex"))
});

const privateKeyObject = privHex => {
  const pubHex = getPublicKey(privHex);
  return crypto.createPrivateKey({
    key: { ...jwkFromPublic(pubHex), d: base64url(Buffer.from(privHex, "hex")) },
    format: "jwk"
  });
};

const publicKeyObject = pubHex =>
  crypto.createPublicKey({ key: jwkFromPublic(pubHex), format: "jwk" });

/* ------------------------------------------- DER 서명과 low-S */

// DER: SEQUENCE { INTEGER r, INTEGER s }
const parseDer = sigHex => {
  const buf = Buffer.from(sigHex, "hex");
  if (buf[0] !== 0x30) {
    throw Error("DER 서명이 아닙니다");
  }
  let offset = 2;
  if (buf[1] & 0x80) {
    // 긴 길이 표기 (일어나지 않지만 규격대로)
    offset = 2 + (buf[1] & 0x7f);
  }
  const readInt = () => {
    if (buf[offset] !== 0x02) {
      throw Error("DER 정수가 아닙니다");
    }
    const length = buf[offset + 1];
    const value = buf.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    return BigInt("0x" + (value.toString("hex") || "0"));
  };
  const r = readInt();
  const s = readInt();
  return { r, s };
};

// 앞에 0x00 을 붙여 음수로 읽히지 않게 하는 DER 정수 인코딩
const encodeDerInt = value => {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) {
    hex = "0" + hex;
  }
  let bytes = Buffer.from(hex, "hex");
  if (bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
};

const encodeDer = (r, s) => {
  const body = Buffer.concat([encodeDerInt(r), encodeDerInt(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString("hex");
};

const isLowS = sigHex => {
  try {
    return parseDer(sigHex).s <= HALF_ORDER;
  } catch (e) {
    return false;
  }
};

// S 가 n/2 를 넘으면 n - S 로 바꾼다. 같은 (r, s) 와 (r, n-s) 는 둘 다 유효하므로
// 하나만 허용해야 서명이 밖에서 바뀌어 돌아다니는 일이 없다.
const normalizeLowS = sigHex => {
  const { r, s } = parseDer(sigHex);
  return encodeDer(r, s > HALF_ORDER ? CURVE_ORDER - s : s);
};

/**
 * 32바이트 메시지(hex 64자)에 서명한다. DER hex, low-S.
 */
const sign = (privHex, messageHex) => {
  if (!/^[0-9a-fA-F]{64}$/.test(messageHex)) {
    throw Error("서명 대상은 32바이트(hex 64자)여야 합니다");
  }
  const der = crypto.sign("sha256", Buffer.from(messageHex, "hex"), {
    key: privateKeyObject(privHex),
    dsaEncoding: "der"
  });
  return normalizeLowS(der.toString("hex"));
};

/**
 * 서명을 확인한다. 모양이 틀리거나 high-S 이면 false.
 */
const verify = (pubHex, messageHex, sigHex) => {
  if (!isValidPublicKey(pubHex) || typeof sigHex !== "string" || !/^[0-9a-fA-F]+$/.test(sigHex)) {
    return false;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(messageHex) || !isLowS(sigHex)) {
    return false;
  }
  try {
    return crypto.verify(
      "sha256",
      Buffer.from(messageHex, "hex"),
      { key: publicKeyObject(pubHex), dsaEncoding: "der" },
      Buffer.from(sigHex, "hex")
    );
  } catch (e) {
    return false;
  }
};

module.exports = {
  CURVE_ORDER,
  HALF_ORDER,
  generatePrivateKey,
  isValidPrivateKey,
  getPublicKey,
  compressPublicKey,
  isValidPublicKey,
  sign,
  verify,
  isLowS,
  normalizeLowS,
  parseDer,
  hexToBigInt,
  bigIntToHex
};
