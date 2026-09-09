/**
 * 주소.
 *
 * 예전에는 비압축 공개키 hex(130자)가 곧 주소였다. 체크섬이 없어 한 글자
 * 틀리면 코인이 사라진다. 거래소 입출금은 체크섬 있는 주소가 사실상 필수다.
 *
 * 비트코인의 P2PKH 와 같은 방식이다.
 *
 *   주소 = Base58Check( version(1) || RIPEMD160(SHA256(공개키)) (20) )
 *   Base58Check = Base58( payload || sha256d(payload)[0..4] )
 *
 * 버전 바이트로 망을 구분한다. 메인넷은 'L' 로, 테스트넷은 'm' 이나 'n' 으로
 * 시작하므로 눈으로도 가려진다. 테스트넷 주소로 메인넷 코인을 보내려 하면
 * 검증에서 떨어진다.
 *
 * 공개키가 주소에서 나오지 않으므로 그 주소의 코인을 쓸 때는 입력에
 * 공개키를 함께 실어야 한다(txIn.publicKey). 검증은 hash(공개키) == 주소를
 * 먼저 보고 그 공개키로 서명을 확인한다.
 *
 * 예전 형식(공개키 hex)도 받는다. 예전 키로 받아 둔 코인을 쓸 수 있어야 한다.
 *
 * 스크립트 주소(P2SH)는 공개키 대신 *조건(redeemScript)* 의 해시를 담는다.
 * 버전 바이트만 다르고 만드는 법은 같다. 다중서명·타임락·HTLC 가 이 주소로
 * 표현된다 (script.js).
 */
const crypto = require("crypto");
const { sha256d } = require("./serialization");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const base58Encode = buf => {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  // 앞의 0 바이트는 '1' 로
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    out = "1" + out;
  }
  return out;
};

const base58Decode = str => {
  let n = 0n;
  for (const ch of str) {
    const digit = ALPHABET.indexOf(ch);
    if (digit === -1) {
      throw Error("Base58 문자가 아닙니다");
    }
    n = n * 58n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) {
    hex = "0" + hex;
  }
  let bytes = Buffer.from(n === 0n ? "" : hex, "hex");
  let leading = 0;
  for (const ch of str) {
    if (ch !== "1") {
      break;
    }
    leading++;
  }
  return Buffer.concat([Buffer.alloc(leading), bytes]);
};

const base58CheckEncode = payload => {
  const checksum = sha256d(payload).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
};

// 체크섬이 맞으면 payload, 아니면 null
const base58CheckDecode = str => {
  let full;
  try {
    full = base58Decode(str);
  } catch (e) {
    return null;
  }
  if (full.length < 5) {
    return null;
  }
  const payload = full.subarray(0, full.length - 4);
  const checksum = full.subarray(full.length - 4);
  return sha256d(payload).subarray(0, 4).equals(checksum) ? payload : null;
};

const hash160 = buf =>
  crypto.createHash("ripemd160").update(crypto.createHash("sha256").update(buf).digest()).digest();

/* ------------------------------------------- 주소 */

const addressFromPublicKey = (pubHex, version) =>
  base58CheckEncode(Buffer.concat([Buffer.from([version]), hash160(Buffer.from(pubHex, "hex"))]));

// 스크립트(redeemScript hex) -> P2SH 주소
const addressFromScript = (scriptHex, scriptVersion) =>
  base58CheckEncode(
    Buffer.concat([Buffer.from([scriptVersion]), hash160(Buffer.from(scriptHex, "hex"))])
  );

// 예전 형식: 비압축 공개키 hex 그대로
const isLegacyAddress = address =>
  typeof address === "string" && /^04[0-9a-fA-F]{128}$/.test(address);

// 체크섬이 맞고, 이 망의 버전 바이트이며, 20바이트 해시를 담고 있는가
const decodeAddress = address => {
  if (typeof address !== "string" || address.length < 26 || address.length > 36) {
    return null;
  }
  const payload = base58CheckDecode(address);
  if (payload === null || payload.length !== 21) {
    return null;
  }
  return { version: payload[0], hash: payload.subarray(1) };
};

const isBase58Address = (address, version) => {
  const decoded = decodeAddress(address);
  return decoded !== null && decoded.version === version;
};

// 스크립트 주소인가 (그렇다면 20바이트 스크립트 해시를 돌려준다)
const scriptHashOf = (address, scriptVersion) => {
  const decoded = decodeAddress(address);
  return decoded !== null && decoded.version === scriptVersion ? decoded.hash : null;
};

// 이 스크립트가 이 주소의 조건인가
const scriptMatchesAddress = (address, scriptHex, scriptVersion) => {
  const wanted = scriptHashOf(address, scriptVersion);
  if (wanted === null || typeof scriptHex !== "string" || !/^([0-9a-fA-F]{2})*$/.test(scriptHex)) {
    return false;
  }
  return wanted.equals(hash160(Buffer.from(scriptHex, "hex")));
};

// 이 망에서 받을 수 있는 주소인가 (예전 형식과 스크립트 주소 포함)
const isAddressValid = (address, version, scriptVersion) =>
  isLegacyAddress(address) ||
  isBase58Address(address, version) ||
  (scriptVersion !== undefined && isBase58Address(address, scriptVersion));

// 이 공개키가 이 주소의 주인인가
const addressMatchesPublicKey = (address, pubHex, version) => {
  if (isLegacyAddress(address)) {
    return address.toLowerCase() === String(pubHex).toLowerCase();
  }
  const decoded = decodeAddress(address);
  if (decoded === null || decoded.version !== version) {
    return false;
  }
  if (typeof pubHex !== "string" || !/^04[0-9a-fA-F]{128}$/.test(pubHex)) {
    return false;
  }
  return decoded.hash.equals(hash160(Buffer.from(pubHex, "hex")));
};

module.exports = {
  base58Encode,
  base58Decode,
  base58CheckEncode,
  base58CheckDecode,
  hash160,
  addressFromPublicKey,
  addressFromScript,
  scriptHashOf,
  scriptMatchesAddress,
  isLegacyAddress,
  isBase58Address,
  decodeAddress,
  isAddressValid,
  addressMatchesPublicKey
};
