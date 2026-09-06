/**
 * 작업증명 — nonce 찾기.
 *
 * 이 파일은 메인 스레드와 워커 스레드 양쪽에서 쓰인다. 해시를 돌리는
 * 부분(findNonce)에는 어떤 상태도 없으므로 그대로 워커에 넘길 수 있다.
 */
const CryptoJS = require("crypto-js"),
  hexToBinary = require("hex-to-binary");

// 헤더 해시. 본문이 아니라 머클 루트가 들어간다 (백서 7장).
const createHash = (index, previousHash, timestamp, merkleRoot, difficulty, nonce) =>
  CryptoJS.SHA256(
    index + previousHash + timestamp + merkleRoot + difficulty + nonce
  ).toString();

// 난이도 = 해시 앞에 붙어야 하는 0 비트 개수
const hashMatchesDifficulty = (hash, difficulty) => {
  const hashInBinary = hexToBinary(hash);
  const requiredZeros = "0".repeat(difficulty);
  return hashInBinary.startsWith(requiredZeros);
};

/**
 * 조건을 만족하는 nonce 를 찾는다.
 *
 * `budget` 만큼만 돌아 보고 못 찾으면 null 을 돌려준다. 부르는 쪽이
 * 중간에 다른 일을 할 수 있게 하기 위한 것이다 — 워커에서는 중단 신호를
 * 확인하고, 메인 스레드에서는 이벤트 루프에 양보한다.
 */
const findNonce = (header, from, budget) => {
  const { index, previousHash, timestamp, merkleRoot, difficulty } = header;
  const until = from + budget;
  for (let nonce = from; nonce < until; nonce++) {
    const hash = createHash(index, previousHash, timestamp, merkleRoot, difficulty, nonce);
    if (hashMatchesDifficulty(hash, difficulty)) {
      return { nonce, hash };
    }
  }
  return null;
};

module.exports = { createHash, hashMatchesDifficulty, findNonce };
