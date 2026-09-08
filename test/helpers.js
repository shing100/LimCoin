/**
 * 테스트 공용 도우미 — 실제로 작업증명을 해서 블록을 만든다.
 *
 * 제네시스 난이도(15)면 nonce 를 수만 번 돌리면 되므로 테스트 안에서
 * 몇백 ms 에 끝난다.
 */
const elliptic = require("elliptic");
const { createCoinbaseTx } = require("../src/transactions");
const { getMerkleRoot } = require("../src/merkle");
const PoW = require("../src/pow");

const ec = new elliptic.ec("secp256k1");
const newAddress = () => ec.genKeyPair().getPublic().encode("hex");

const now = () => Math.round(Date.now() / 1000);

// previousBlock 위에 data 를 담은 블록을 실제로 채굴한다.
// offset 은 타임스탬프를 몇 초 뒤로 둘지 — 같은 초에 여러 블록을 만들 때 MTP 를 넘기려는 것.
const mineOnto = (previousBlock, data, offset = 0) => {
  const index = previousBlock.index + 1;
  const timestamp = Math.max(now() + offset, previousBlock.timestamp + 1);
  const merkleRoot = getMerkleRoot(data);
  const difficulty = previousBlock.difficulty;
  const header = { index, previousHash: previousBlock.hash, timestamp, merkleRoot, difficulty };

  for (let from = 0; ; from += 200000) {
    const found = PoW.findNonce(header, from, 200000);
    if (found !== null) {
      return {
        index,
        hash: found.hash,
        previousHash: previousBlock.hash,
        timestamp,
        merkleRoot,
        data,
        difficulty,
        nonce: found.nonce
      };
    }
  }
};

// 코인베이스 하나만 든 블록
const coinbaseBlockOnto = (previousBlock, address = newAddress(), offset = 0) =>
  mineOnto(previousBlock, [createCoinbaseTx(address, previousBlock.index + 1, 0)], offset);

// previousBlock 위에 n 개를 이어 채굴한다
const mineChainOnto = (previousBlock, n, offset = 0) => {
  const blocks = [];
  let tip = previousBlock;
  for (let i = 0; i < n; i++) {
    tip = coinbaseBlockOnto(tip, newAddress(), offset + i);
    blocks.push(tip);
  }
  return blocks;
};

module.exports = { newAddress, mineOnto, coinbaseBlockOnto, mineChainOnto };
