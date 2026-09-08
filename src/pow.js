/**
 * 작업증명 — nonce 찾기.
 *
 * 이 파일은 메인 스레드와 워커 스레드 양쪽에서 쓰인다. 해시를 돌리는
 * 부분(findNonce)에는 어떤 상태도 없으므로 그대로 워커에 넘길 수 있다.
 */
const { blockHashOf } = require("./serialization");

// 헤더 해시 = sha256d(84바이트 헤더). 본문이 아니라 머클 루트가 들어간다 (백서 7장).
// 예전에는 필드를 문자열로 이어 붙여 SHA256 한 번이었다 — serialization.js 참고.
const createHash = (index, previousHash, timestamp, merkleRoot, difficulty, nonce) =>
  blockHashOf({ index, previousHash, timestamp, merkleRoot, difficulty, nonce });

// 난이도 = 해시 앞에 붙어야 하는 0 비트 개수.
// hex 한 글자가 4비트이므로 글자 단위로 세고 마지막 글자만 비트를 본다.
const leadingZeroBits = hash => {
  let bits = 0;
  for (const ch of hash) {
    const nibble = parseInt(ch, 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    // 이 nibble 의 앞자리 0 개수 (1..3)
    bits += nibble < 2 ? 3 : nibble < 4 ? 2 : nibble < 8 ? 1 : 0;
    break;
  }
  return bits;
};

const hashMatchesDifficulty = (hash, difficulty) => leadingZeroBits(hash) >= difficulty;

/**
 * 조건을 만족하는 nonce 를 찾는다.
 *
 * `budget` 번만 시도해 보고 못 찾으면 null 을 돌려준다. 부르는 쪽이 중간에
 * 다른 일을 할 수 있게 하기 위한 것이다 — 워커에서는 중단 신호를 확인한다.
 *
 * `stride` 는 여러 워커가 겹치지 않게 나눠 돌 때 쓴다. 워커 k 가
 * from=k, stride=N 으로 돌면 nonce 공간을 N 등분해 맡는다.
 */
const findNonce = (header, from, budget, stride = 1) => {
  const { index, previousHash, timestamp, merkleRoot, difficulty } = header;
  let nonce = from;
  for (let i = 0; i < budget; i++) {
    const hash = createHash(index, previousHash, timestamp, merkleRoot, difficulty, nonce);
    if (hashMatchesDifficulty(hash, difficulty)) {
      return { nonce, hash };
    }
    nonce += stride;
  }
  return null;
};

module.exports = { createHash, hashMatchesDifficulty, leadingZeroBits, findNonce };
