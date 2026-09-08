/**
 * 정규 직렬화 — 트랜잭션과 블록 헤더를 바이트로.
 *
 * 예전에는 문자열을 이어 붙여 해시했다.
 *
 *   txid  = SHA256(txOutId + txOutIndex + ... + address + amount + ...)
 *   블록  = SHA256(index + previousHash + timestamp + merkleRoot + difficulty + nonce)
 *
 * 구분자가 없어 자릿수가 다른 값이 맞물리면 다른 내용이 같은 문자열이 될 수
 * 있고(주소 길이가 가변이 되면 바로 그렇게 된다), 무엇보다 "JavaScript 의
 * 숫자를 문자열로 바꾸는 방식"이 곧 합의 규칙이었다. 다른 언어로 노드나
 * 지갑을 만들려면 그것을 그대로 흉내 내야 했다.
 *
 * 이제 바이트 단위로 정한다. 비트코인과 같은 관례를 따른다.
 *
 *   정수     리틀 엔디언 고정 폭 (uint32 / uint64)
 *   개수     CompactSize varint
 *   해시     32바이트 (hex 를 바이트로). 코인베이스의 빈 txOutId 는 0 32개
 *   문자열   varint 길이 + UTF-8 바이트
 *   해시 함수 sha256d = SHA256(SHA256(x))
 *
 * 트랜잭션 직렬화에 서명과 공개키는 들어가지 않는다. txid 가 "무엇을 어디로
 * 보내는가"만 덮으므로 서명 바이트가 바뀌어도 txid 는 같다(malleability 없음).
 * 서명은 txid 위에 한다.
 */
const crypto = require("crypto");

const sha256 = buf => crypto.createHash("sha256").update(buf).digest();
const sha256d = buf => sha256(sha256(buf));
const sha256dHex = buf => sha256d(buf).toString("hex");

const ZERO_HASH = "0".repeat(64);

/* ------------------------------------------- 쓰기 */

const writeVarint = n => {
  if (n < 0xfd) {
    return Buffer.from([n]);
  }
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
};

const writeUInt32 = n => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw Error(`uint32 범위를 벗어났습니다: ${n}`);
  }
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
};

const writeUInt64 = n => {
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw Error(`uint64 범위를 벗어났습니다: ${n}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
};

const writeHash = hex => {
  if (hex === "") {
    return Buffer.from(ZERO_HASH, "hex");
  }
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw Error(`32바이트 해시가 아닙니다: ${hex}`);
  }
  return Buffer.from(hex, "hex");
};

const writeString = s => {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([writeVarint(bytes.length), bytes]);
};

/* ------------------------------------------- 트랜잭션 / 헤더 */

/**
 * 트랜잭션 -> 바이트 (서명·공개키 제외).
 *
 *   varint 입력 수
 *   입력마다: 32바이트 txOutId, uint32 txOutIndex
 *   varint 출력 수
 *   출력마다: varstr 주소, uint64 금액
 */
const serializeTx = tx => {
  const parts = [writeVarint(tx.txIns.length)];
  for (const txIn of tx.txIns) {
    parts.push(writeHash(txIn.txOutId), writeUInt32(txIn.txOutIndex));
  }
  parts.push(writeVarint(tx.txOuts.length));
  for (const txOut of tx.txOuts) {
    parts.push(writeString(txOut.address), writeUInt64(txOut.amount));
  }
  return Buffer.concat(parts);
};

const txIdOf = tx => sha256dHex(serializeTx(tx));

/**
 * 블록 헤더 -> 84바이트.
 *
 *   uint32 index | 32바이트 previousHash | uint32 timestamp |
 *   32바이트 merkleRoot | uint32 difficulty | uint64 nonce
 */
const serializeHeader = ({ index, previousHash, timestamp, merkleRoot, difficulty, nonce }) =>
  Buffer.concat([
    writeUInt32(index),
    writeHash(previousHash),
    writeUInt32(timestamp),
    writeHash(merkleRoot),
    writeUInt32(difficulty),
    writeUInt64(nonce)
  ]);

const blockHashOf = header => sha256dHex(serializeHeader(header));

module.exports = {
  sha256,
  sha256d,
  sha256dHex,
  ZERO_HASH,
  writeVarint,
  writeUInt32,
  writeUInt64,
  writeHash,
  writeString,
  serializeTx,
  txIdOf,
  serializeHeader,
  blockHashOf
};
