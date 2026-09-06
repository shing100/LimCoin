/**
 * 블록 해시 / 트랜잭션 id -> 블록 높이 색인.
 *
 * 지금까지 조회는 전부 체인을 훑는 것이었다.
 *
 *   GET /blocks/:hash        _.find(chain, { hash })          O(블록 수)
 *   GET /transactions/:id    체인 전체를 펼쳐서 find           O(트랜잭션 수)
 *   GET /search/:query       위 둘을 차례로                    O(트랜잭션 수)
 *   getTxProof(id)           블록마다 머클 트리를 새로 만든다  O(트랜잭션 수 x log)
 *
 * 마지막 것이 특히 나쁘다. 찾을 때까지 블록마다 머클 트리를 통째로 쌓는다.
 * 익스플로러의 트랜잭션 페이지가 열릴 때마다 그 값을 냈다.
 *
 * 주소 색인(addressIndex.js)과 같은 자리에서 같은 방식으로 갱신한다 —
 * 블록을 붙일 때 더하고, 체인이 갈라지면 밀려난 블록만큼 걷어 낸다.
 */

let blockByHash = new Map(); // 블록 해시 -> 높이
let blockByTxId = new Map(); // 트랜잭션 id -> 그 트랜잭션이 담긴 블록의 높이

const reset = () => {
  blockByHash = new Map();
  blockByTxId = new Map();
};

const applyBlock = block => {
  blockByHash.set(block.hash, block.index);
  for (const tx of block.data || []) {
    blockByTxId.set(tx.id, block.index);
  }
};

/**
 * 체인에서 밀려난 블록들을 색인에서 뺀다.
 *
 * 높이로 훑지 않고 밀려난 블록을 그대로 받는다. 그래야 지운 만큼만 일한다.
 */
const rollbackBlocks = blocks => {
  for (const block of blocks) {
    blockByHash.delete(block.hash);
    for (const tx of block.data || []) {
      // 같은 트랜잭션이 새 체인에도 담겼다면 그쪽이 다시 넣어 준다
      blockByTxId.delete(tx.id);
    }
  }
};

const rebuild = chain => {
  reset();
  for (const block of chain) {
    applyBlock(block);
  }
};

const findBlockHeight = hash => blockByHash.get(hash);
const findTxHeight = txId => blockByTxId.get(txId);

const getIndexedTxCount = () => blockByTxId.size;

module.exports = {
  reset,
  applyBlock,
  rollbackBlocks,
  rebuild,
  findBlockHeight,
  findTxHeight,
  getIndexedTxCount
};
