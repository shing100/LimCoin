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
// difficulty 를 주지 않으면 직전 블록과 같게 한다 (난이도 조정 높이를 지나지 않을 때만 맞다).
const mineOnto = (previousBlock, data, offset = 0, difficulty = previousBlock.difficulty) => {
  const index = previousBlock.index + 1;
  const timestamp = Math.max(now() + offset, previousBlock.timestamp + 1);
  const merkleRoot = getMerkleRoot(data);
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
const coinbaseBlockOnto = (previousBlock, address = newAddress(), offset = 0, difficulty) =>
  mineOnto(previousBlock, [createCoinbaseTx(address, previousBlock.index + 1, 0)], offset, difficulty);

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
    const difficulty = chainSoFar.length > 1 || chainSoFar[0].index === 0
      ? Blockchain.difficultyForNext(chainSoFar)
      : tip.difficulty;
    tip = coinbaseBlockOnto(tip, newAddress(), offset + i * 10, difficulty);
    blocks.push(tip);
    chainSoFar = chainSoFar.concat([tip]);
  }
  return blocks;
};

module.exports = { newAddress, mineOnto, coinbaseBlockOnto, mineChainOnto };
