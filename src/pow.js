/**
 * 작업증명 — nonce 찾기.
 *
 * 이 파일은 메인 스레드와 워커 스레드 양쪽에서 쓰인다. 해시를 돌리는
 * 부분(findNonce)에는 어떤 상태도 없으므로 그대로 워커에 넘길 수 있다.
 *
 * 난이도는 목표값(target.js)이다. 해시를 큰 정수로 읽어 target 이하이면
 * 통과다. 예전의 "앞자리 0 비트 개수"는 한 칸이 2배라 너무 거칠었다.
 */
const { blockHashOf } = require("./serialization");
const Target = require("./target");

// 헤더 해시 = sha256d(88바이트 헤더). 본문이 아니라 머클 루트가 들어간다 (백서 7장).
const createHash = header => blockHashOf(header);

// 해시가 bits 가 가리키는 목표값 이하인가 (검증용 — 채굴 루프는 compileTarget 을 쓴다)
const hashMeetsBits = Target.hashMeetsBits;

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
  const { version, index, previousHash, timestamp, merkleRoot, bits } = header;
  const compiled = Target.compileTarget(bits);
  let nonce = from;
  for (let i = 0; i < budget; i++) {
    const hash = createHash({ version, index, previousHash, timestamp, merkleRoot, bits, nonce });
    if (Target.hashMeetsCompiled(hash, compiled)) {
      return { nonce, hash };
    }
    nonce += stride;
  }
  return null;
};

module.exports = { createHash, hashMeetsBits, leadingZeroBits: Target.leadingZeroBits, findNonce };
