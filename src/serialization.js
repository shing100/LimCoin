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
 *   uint32 lockTime
 *
 * lockTime 은 "이 높이(또는 시각)가 되어야 블록에 담길 수 있다"이다. 0 이면
 * 제한이 없다. 스크립트의 OP_CHECKLOCKTIMEVERIFY 가 이 값을 본다.
 * 해제 데이터(서명, 공개키, redeemScript, unlock)는 여전히 들어가지 않는다.
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
  parts.push(writeUInt32(tx.lockTime || 0));
  return Buffer.concat(parts);
};

const txIdOf = tx => sha256dHex(serializeTx(tx));

/* ------------------------------------------- 크기 (수수료·블록 한도용)
 *
 * 수수료는 "이 트랜잭션이 블록에서 차지하는 자리"에 매겨야 한다. 예전에는
 * 입력 개수를 크기의 대용으로 썼다 — 출력이 백 개인 트랜잭션과 두 개인
 * 트랜잭션이 같은 값을 냈다.
 *
 * 크기는 txid 가 덮는 바이트에 해제 데이터(서명, 공개키, redeemScript,
 * unlock)를 더한 것이다. 해제 데이터도 망으로 오가고 디스크에 남으므로
 * 값을 매겨야 한다. 다만 txid 에는 들어가지 않으므로(malleability 없음)
 * 크기는 서명 뒤에야 확정된다.
 */
const varintSize = n => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);

// hex 문자열이 나타내는 바이트 수 (형식이 틀려도 던지지 않는다 — 크기만 센다)
const hexBytes = value => (typeof value === "string" ? Math.ceil(value.length / 2) : 0);

// varint 길이 + 바이트
const fieldSize = value => {
  const bytes = hexBytes(value);
  return varintSize(bytes) + bytes;
};

const txSizeOf = tx => {
  let size = serializeTx(tx).length;
  for (const txIn of tx.txIns) {
    size += fieldSize(txIn.signature) + fieldSize(txIn.publicKey) + fieldSize(txIn.redeemScript);
    const unlock = Array.isArray(txIn.unlock) ? txIn.unlock : [];
    size += varintSize(unlock.length);
    for (const item of unlock) {
      size += fieldSize(item);
    }
  }
  return size;
};

/*
 * 아직 서명하지 않은 트랜잭션의 크기를 미리 잰다 (지갑이 수수료를 정할 때).
 *
 * P2PKH 입력 하나 = 서명 DER 71~72바이트 + 비압축 공개키 65바이트 + 길이들.
 * 넉넉한 쪽(72)으로 잡는다 — 모자라게 잡으면 수수료가 부족해 안 담긴다.
 */
const SIGNATURE_BYTES = 72;
const PUBLIC_KEY_BYTES = 65;
const estimateTxSize = (inputCount, outputCount, addressBytes = 34) =>
  varintSize(inputCount) +
  inputCount * (32 + 4 + fieldSizeOfBytes(SIGNATURE_BYTES) + fieldSizeOfBytes(PUBLIC_KEY_BYTES) + 1 + 1) +
  varintSize(outputCount) +
  outputCount * (varintSize(addressBytes) + addressBytes + 8) +
  4;

const fieldSizeOfBytes = bytes => varintSize(bytes) + bytes;

/**
 * 블록 헤더 -> 88바이트.
 *
 *   uint32 version | uint32 index | 32바이트 previousHash | uint32 timestamp |
 *   32바이트 merkleRoot | uint32 bits | uint64 nonce
 *
 * version 은 앞으로 규칙을 바꿀 때 채굴자가 찬성을 표시하는 자리다(비트코인의
 * BIP9). 지금은 1. bits 는 압축 목표값(target.js).
 */
const serializeHeader = ({ version, index, previousHash, timestamp, merkleRoot, bits, nonce }) =>
  Buffer.concat([
    writeUInt32(version),
    writeUInt32(index),
    writeHash(previousHash),
    writeUInt32(timestamp),
    writeHash(merkleRoot),
    writeUInt32(bits),
    writeUInt64(nonce)
  ]);

const blockHashOf = header => sha256dHex(serializeHeader(header));

/* ------------------------------------------- 읽기 (커서)
 *
 * 지금까지 직렬화는 한쪽으로만 갔다 — 해시를 내려고 바이트를 만들 뿐,
 * 되읽을 일이 없었다. 밖에서 트랜잭션을 받을 때는 JSON 을 그대로 썼다.
 *
 * 거래소나 다른 언어 지갑이 쓰는 도구는 대개 "raw hex" 를 주고받는다.
 * 되읽을 수 있어야 그 형식을 쓸 수 있다.
 */
const reader = hex => {
  if (typeof hex !== "string" || !/^([0-9a-fA-F]{2})*$/.test(hex)) {
    throw Error("hex 가 아닙니다");
  }
  return { buf: Buffer.from(hex, "hex"), at: 0 };
};

const need = (cursor, bytes) => {
  if (cursor.at + bytes > cursor.buf.length) {
    throw Error(`바이트가 모자랍니다 (${bytes} 더 필요, ${cursor.buf.length - cursor.at} 남음)`);
  }
};

const readUInt32 = cursor => {
  need(cursor, 4);
  const value = cursor.buf.readUInt32LE(cursor.at);
  cursor.at += 4;
  return value;
};

const readUInt64 = cursor => {
  need(cursor, 8);
  const value = cursor.buf.readBigUInt64LE(cursor.at);
  cursor.at += 8;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Error(`금액이 안전한 정수 범위를 넘습니다: ${value}`);
  }
  return Number(value);
};

const readVarint = cursor => {
  need(cursor, 1);
  const first = cursor.buf[cursor.at++];
  if (first < 0xfd) {
    return first;
  }
  if (first === 0xfd) {
    need(cursor, 2);
    const value = cursor.buf.readUInt16LE(cursor.at);
    cursor.at += 2;
    if (value < 0xfd) {
      throw Error("varint 가 최소 표기가 아닙니다");
    }
    return value;
  }
  if (first === 0xfe) {
    need(cursor, 4);
    const value = cursor.buf.readUInt32LE(cursor.at);
    cursor.at += 4;
    if (value <= 0xffff) {
      throw Error("varint 가 최소 표기가 아닙니다");
    }
    return value;
  }
  need(cursor, 8);
  const value = cursor.buf.readBigUInt64LE(cursor.at);
  cursor.at += 8;
  if (value <= 0xffffffffn) {
    throw Error("varint 가 최소 표기가 아닙니다");
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Error("varint 가 너무 큽니다");
  }
  return Number(value);
};

const readHash = cursor => {
  need(cursor, 32);
  const hex = cursor.buf.subarray(cursor.at, cursor.at + 32).toString("hex");
  cursor.at += 32;
  return hex === ZERO_HASH ? "" : hex;
};

// varint 길이 + 바이트 -> hex
const readVarBytes = cursor => {
  const length = readVarint(cursor);
  need(cursor, length);
  const hex = cursor.buf.subarray(cursor.at, cursor.at + length).toString("hex");
  cursor.at += length;
  return hex;
};

/*
 * varint 길이 + UTF-8.
 *
 * UTF-8 로 읽히지 않는 바이트가 있으면 거부한다. Buffer.toString("utf8") 은
 * 그런 바이트를 U+FFFD 로 바꿔 주는데, 그 문자열을 다시 적으면 3바이트가 되어
 * 원래 바이트와 달라진다 — 즉 왕복이 깨지고, 서로 다른 바이트가 같은
 * 트랜잭션으로 읽힌다. 주소는 어차피 Base58(또는 공개키 hex) ASCII 라
 * 잃는 것이 없다.
 */
const readVarString = cursor => {
  const length = readVarint(cursor);
  need(cursor, length);
  const bytes = cursor.buf.subarray(cursor.at, cursor.at + length);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw Error("문자열이 UTF-8 이 아닙니다");
  }
  cursor.at += length;
  return text;
};

const done = cursor => {
  if (cursor.at !== cursor.buf.length) {
    throw Error(`뒤에 ${cursor.buf.length - cursor.at}바이트가 남았습니다`);
  }
};

/* ------------------------------------------- raw 트랜잭션
 *
 * txid 를 내는 직렬화(serializeTx)와 다르다. 그쪽은 "무엇을 어디로"만 덮어
 * 서명이 바뀌어도 id 가 그대로다(malleability 없음). 이쪽은 망으로 보내고
 * 디스크에 남기는 형식이라 해제 데이터까지 전부 들어간다.
 *
 *   varint 입력 수
 *   입력마다: 32B txOutId | uint32 txOutIndex | varbytes signature |
 *             varbytes publicKey | varbytes redeemScript |
 *             varint unlock 수 | 항목마다 varbytes
 *   varint 출력 수
 *   출력마다: varstr 주소 | uint64 금액
 *   uint32 lockTime
 *
 * id 는 담지 않는다. 되읽는 쪽이 내용에서 다시 계산한다 — 남이 적어 보낸
 * id 를 믿을 이유가 없다.
 */
const writeVarBytes = hex => {
  if (hex === undefined || hex === null || hex === "") {
    return Buffer.from([0]);
  }
  if (typeof hex !== "string" || !/^([0-9a-fA-F]{2})*$/.test(hex)) {
    throw Error(`hex 가 아닙니다: ${hex}`);
  }
  const bytes = Buffer.from(hex, "hex");
  return Buffer.concat([writeVarint(bytes.length), bytes]);
};

const encodeTx = tx => {
  if (tx === null || typeof tx !== "object" || !Array.isArray(tx.txIns) || !Array.isArray(tx.txOuts)) {
    throw Error("트랜잭션 모양이 아닙니다");
  }
  const parts = [writeVarint(tx.txIns.length)];
  for (const txIn of tx.txIns) {
    const unlock = Array.isArray(txIn.unlock) ? txIn.unlock : [];
    parts.push(
      writeHash(txIn.txOutId),
      writeUInt32(txIn.txOutIndex),
      writeVarBytes(txIn.signature),
      writeVarBytes(txIn.publicKey),
      writeVarBytes(txIn.redeemScript),
      writeVarint(unlock.length),
      ...unlock.map(writeVarBytes)
    );
  }
  parts.push(writeVarint(tx.txOuts.length));
  for (const txOut of tx.txOuts) {
    parts.push(writeString(txOut.address), writeUInt64(txOut.amount));
  }
  parts.push(writeUInt32(tx.lockTime || 0));
  return Buffer.concat(parts).toString("hex");
};

// 커서에서 트랜잭션 하나를 읽는다 (블록 안에서도 쓴다)
const readTx = cursor => {
  const inputCount = readVarint(cursor);
  if (inputCount === 0) {
    throw Error("입력이 없습니다");
  }
  const txIns = [];
  for (let i = 0; i < inputCount; i++) {
    const txOutId = readHash(cursor);
    const txOutIndex = readUInt32(cursor);
    const signature = readVarBytes(cursor);
    const publicKey = readVarBytes(cursor);
    const redeemScript = readVarBytes(cursor);
    const unlockCount = readVarint(cursor);
    const unlock = [];
    for (let k = 0; k < unlockCount; k++) {
      unlock.push(readVarBytes(cursor));
    }
    const txIn = { txOutId, txOutIndex, signature };
    // 없는 것은 넣지 않는다 — JSON 모양이 보내기 전과 같아야 한다
    if (publicKey !== "") {
      txIn.publicKey = publicKey;
    }
    if (redeemScript !== "") {
      txIn.redeemScript = redeemScript;
    }
    if (unlockCount > 0) {
      txIn.unlock = unlock;
    }
    txIns.push(txIn);
  }
  const outputCount = readVarint(cursor);
  if (outputCount === 0) {
    throw Error("출력이 없습니다");
  }
  const txOuts = [];
  for (let i = 0; i < outputCount; i++) {
    const address = readVarString(cursor);
    const amount = readUInt64(cursor);
    txOuts.push({ address, amount });
  }
  const lockTime = readUInt32(cursor);
  const tx = { txIns, txOuts, lockTime, id: "" };
  tx.id = txIdOf(tx);
  return tx;
};

const decodeTx = hex => {
  const cursor = reader(hex);
  const tx = readTx(cursor);
  done(cursor);
  return tx;
};

/* ------------------------------------------- raw 블록
 *
 *   88바이트 헤더 | varint 트랜잭션 수 | raw 트랜잭션들
 *
 * 헤더에 hash 는 담지 않는다 — 헤더에서 바로 나온다.
 */
const encodeBlock = block =>
  Buffer.concat([
    serializeHeader(block),
    writeVarint(block.data.length),
    ...block.data.map(tx => Buffer.from(encodeTx(tx), "hex"))
  ]).toString("hex");

const decodeBlock = hex => {
  const cursor = reader(hex);
  const version = readUInt32(cursor);
  const index = readUInt32(cursor);
  const previousHash = readHash(cursor) || ZERO_HASH;
  const timestamp = readUInt32(cursor);
  const merkleRoot = readHash(cursor);
  const bits = readUInt32(cursor);
  need(cursor, 8);
  const nonce = readUInt64(cursor);
  const count = readVarint(cursor);
  const data = [];
  for (let i = 0; i < count; i++) {
    data.push(readTx(cursor));
  }
  done(cursor);
  const header = { version, index, previousHash, timestamp, merkleRoot, bits, nonce };
  return { ...header, hash: blockHashOf(header), data };
};

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
  varintSize,
  txSizeOf,
  estimateTxSize,
  SIGNATURE_BYTES,
  PUBLIC_KEY_BYTES,
  serializeHeader,
  blockHashOf,
  encodeTx,
  decodeTx,
  encodeBlock,
  decodeBlock
};
