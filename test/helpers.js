/**
 * 테스트 공용 도우미 — 실제로 작업증명을 해서 블록을 만든다.
 *
 * 제네시스 난이도(15)면 nonce 를 수만 번 돌리면 되므로 테스트 안에서
 * 몇백 ms 에 끝난다.
 */
const Keys = require("../src/keys");
const { createCoinbaseTx } = require("../src/transactions");
const { getMerkleRoot } = require("../src/merkle");
const PoW = require("../src/pow");

/*
 * elliptic 시절 테스트가 쓰던 keyPair 모양을 Node crypto 위에 흉내 낸다.
 *
 *   keyPair.sign(txId).toDER()        -> 서명 바이트 (low-S DER)
 *   keyPair.getPublic().encode("hex") -> 비압축 공개키 hex
 *
 * 테스트 파일 여덟 개가 이 모양에 기대고 있어, 형식을 바꾸는 대신 맞춰 준다.
 * 새 테스트는 Keys 를 바로 쓰면 된다.
 */
const keyPairFrom = privateKey => {
  const publicKey = Keys.getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    sign: txId => ({ toDER: () => Buffer.from(Keys.sign(privateKey, txId), "hex") }),
    getPublic: () => ({ encode: () => publicKey }),
    getPrivate: () => ({ toString: () => privateKey })
  };
};

const ecShim = {
  genKeyPair: () => keyPairFrom(Keys.generatePrivateKey()),
  keyFromPrivate: privateKey => keyPairFrom(privateKey)
};

// 예전 형식 주소(공개키 hex). 테스트는 두 형식 다 다뤄야 하므로 둘 다 둔다.
const newAddress = () => ecShim.genKeyPair().publicKey;

/*
 * 테스트용 가짜 트랜잭션 id. txOutId 는 직렬화에서 32바이트여야 하므로
 * "seed" 같은 이름을 그대로 쓸 수 없다. 이름을 sha256 해서 64자로 만든다.
 * 이미 64자 hex 면 그대로 둔다 — 진짜 id 와 섞어 써도 된다.
 */
const fakeId = label =>
  /^[0-9a-f]{64}$/i.test(label)
    ? label
    : require("crypto").createHash("sha256").update(String(label)).digest("hex");

const now = () => Math.round(Date.now() / 1000);

// mineOnto 가 쓰는 타임스탬프 — bits 를 정할 때 같은 값을 쓰려고 밖에서도 부른다
const timestampFor = (previousBlock, offset = 0) =>
  Math.max(now() + offset, previousBlock.timestamp + 1);

// previousBlock 위에 data 를 담은, 타임스탬프가 timestamp 인 블록을 실제로 채굴한다.
// bits 를 주지 않으면 직전 블록과 같게 한다 (처음 lwmaWindow 블록 안, 메인넷에서만 맞다).
const mineOntoAt = (previousBlock, data, timestamp, bits = previousBlock.bits) => {
  const index = previousBlock.index + 1;
  const merkleRoot = getMerkleRoot(data);
  const header = { version: 1, index, previousHash: previousBlock.hash, timestamp, merkleRoot, bits };

  for (let from = 0; ; from += 200000) {
    const found = PoW.findNonce(header, from, 200000);
    if (found !== null) {
      return {
        version: 1,
        index,
        hash: found.hash,
        previousHash: previousBlock.hash,
        timestamp,
        merkleRoot,
        data,
        bits,
        nonce: found.nonce
      };
    }
  }
};

// offset 은 타임스탬프를 지금에서 몇 초 뒤로 둘지 — 같은 초에 여러 블록을 만들 때 MTP 를 넘기려는 것.
const mineOnto = (previousBlock, data, offset = 0, bits) =>
  mineOntoAt(previousBlock, data, timestampFor(previousBlock, offset), bits);

// 코인베이스 하나만 든 블록
const coinbaseBlockOnto = (previousBlock, address = newAddress(), offset = 0, bits) =>
  mineOnto(previousBlock, [createCoinbaseTx(address, previousBlock.index + 1, 0)], offset, bits);
const coinbaseBlockOntoAt = (previousBlock, address = newAddress(), timestamp, bits) =>
  mineOntoAt(previousBlock, [createCoinbaseTx(address, previousBlock.index + 1, 0)], timestamp, bits);

/*
 * previousBlock 위에 n 개를 이어 채굴한다.
 *
 * 난이도는 프로토콜이 그 높이에서 요구하는 값으로 맞춘다 — 10블록마다
 * 조정되므로 그 지점을 지나면 직전 블록 난이도를 그대로 쓰면 틀린다.
 * 앞선 체인(base)은 previousBlock 이 우리 체인에 있으면 거기서 가져오고,
 * 아니면 previousBlock 하나로 시작한다.
 *
 * 타임스탬프는 10초씩 띄운다. 1초씩 띄우면 "너무 빨리 나왔다"고 난이도가
 * 올라가 채굴이 배로 느려진다.
 */
const mineChainOnto = (previousBlock, n, offset = 0, base) => {
  const Blockchain = require("../src/blockchain");
  const ours = Blockchain.getBlockChain();
  let chainSoFar =
    base ||
    (ours[previousBlock.index] && ours[previousBlock.index].hash === previousBlock.hash
      ? ours.slice(0, previousBlock.index + 1)
      : [previousBlock]);

  const blocks = [];
  let tip = previousBlock;
  for (let i = 0; i < n; i++) {
    const timestamp = timestampFor(tip, offset + i * 10);
    const bits = chainSoFar.length > 1 || chainSoFar[0].index === 0
      ? Blockchain.bitsForNext(chainSoFar, timestamp)
      : tip.bits;
    tip = coinbaseBlockOnto(tip, newAddress(), offset + i * 10, bits);
    blocks.push(tip);
    chainSoFar = chainSoFar.concat([tip]);
  }
  return blocks;
};

module.exports = {
  ecShim, keyPairFrom, fakeId, newAddress, timestampFor,
  mineOnto, mineOntoAt, coinbaseBlockOnto, coinbaseBlockOntoAt, mineChainOnto
};
