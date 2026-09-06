/**
 * 머클 트리.
 *
 * 백서 7장 "Reclaiming Disk Space":
 *
 *   "To facilitate this without breaking the block's hash, transactions are
 *    hashed in a Merkle Tree, with only the root included in the block's hash."
 *
 * 원래 LimCoin 은 블록 해시에 JSON.stringify(data) 를 통째로 넣었다. 그래서
 *
 *  - 키 순서가 바뀌면 같은 내용인데도 해시가 달라진다(직렬화에 합의가 매달림)
 *  - 트랜잭션 하나가 블록에 들어 있는지 확인하려면 블록 전체를 받아야 한다
 *  - 헤더만 따로 떼어 검증할 수 없다(백서 8장 SPV 불가)
 *
 * 머클 루트를 쓰면 헤더가 고정 크기가 되고, 트랜잭션 하나의 포함 증명은
 * log2(n) 개 해시로 끝난다.
 */
const CryptoJS = require("crypto-js");

// 트랜잭션이 없는 트리의 루트. 실제로는 코인베이스가 항상 있으므로 쓰이지 않는다.
const EMPTY_ROOT = "0".repeat(64);

const hashPair = (left, right) => CryptoJS.SHA256(left + right).toString();

// 한 단계 위로 접는다. 개수가 홀수면 마지막 것을 자기 자신과 짝짓는다(비트코인과 동일).
const foldLevel = level => {
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i];
    const right = i + 1 < level.length ? level[i + 1] : left;
    next.push(hashPair(left, right));
  }
  return next;
};

const toLeaves = txs => txs.map(tx => tx.id);

const getMerkleRoot = txs => {
  if (!(txs instanceof Array) || txs.length === 0) {
    return EMPTY_ROOT;
  }
  let level = toLeaves(txs);
  while (level.length > 1) {
    level = foldLevel(level);
  }
  return level[0];
};

/**
 * txId 가 이 트랜잭션 집합에 들어 있다는 증명을 만든다.
 * 각 단계에서 나와 짝을 이룬 해시와, 그것이 왼쪽인지 오른쪽인지를 남긴다.
 * 검증하는 쪽은 블록 헤더의 머클 루트만 있으면 된다(백서 8장).
 */
const getMerkleProof = (txs, txId) => {
  if (!(txs instanceof Array) || txs.length === 0) {
    return null;
  }
  let level = toLeaves(txs);
  let index = level.indexOf(txId);
  if (index === -1) {
    return null;
  }

  const proof = [];
  while (level.length > 1) {
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;
    // 홀수 개라 짝이 없으면 자기 자신과 짝지어진 것이다
    const sibling = siblingIndex < level.length ? level[siblingIndex] : level[index];

    proof.push({ position: isRightNode ? "left" : "right", hash: sibling });

    level = foldLevel(level);
    index = Math.floor(index / 2);
  }
  return proof;
};

const verifyMerkleProof = (txId, proof, merkleRoot) => {
  if (!(proof instanceof Array)) {
    return false;
  }
  const computed = proof.reduce(
    (hash, step) =>
      step.position === "left"
        ? hashPair(step.hash, hash)
        : hashPair(hash, step.hash),
    txId
  );
  return computed === merkleRoot;
};

module.exports = { getMerkleRoot, getMerkleProof, verifyMerkleProof, EMPTY_ROOT };
