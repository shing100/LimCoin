const _ = require("lodash"),
  Transactions = require("./transactions");

const { validateTx, getTxFee } = Transactions;
const { keyOf, indexByOutpoint } = require("./utxo");

// mempool 에 무한정 쌓이지 않게 상한을 둔다.
// 예전에는 제한이 없어 스팸 트랜잭션으로 메모리를 밀어낼 수 있었다.
const MAX_MEMPOOL_SIZE = 500;

let mempool = [];

const getMempool = () => _.cloneDeep(mempool);

// 지금 pool 이 쓰기로 예약한 outpoint 들
const spentInPool = pool => {
  const keys = new Set();
  for (const tx of pool) {
    for (const txIn of tx.txIns) {
      keys.add(keyOf(txIn.txOutId, txIn.txOutIndex));
    }
  }
  return keys;
};

/*
 * 같은 UTxO 를 두 번 쓰려는 트랜잭션인지 본다(이중지불).
 *
 * 예전에는 mempool 전체를 펼쳐 놓고 txIn 마다 선형으로 훑었다.
 * mempool 이 상한(500)까지 차면 추가 한 번에 수만 번을 비교하게 된다.
 */
const isTxValidForPool = (tx, pool) => {
  const pending = spentInPool(pool);
  return tx.txIns.every(
    txIn => !pending.has(keyOf(txIn.txOutId, txIn.txOutIndex))
  );
};

/*
 * 블록이 붙은 뒤, 더는 유효하지 않은 트랜잭션을 pool 에서 뺀다.
 *
 * 예전에는 txIn 마다 UTxOut 배열 전체를 선형으로 훑었다.
 * mempool 500건 x UTxOut 2만개면 블록 하나마다 천만 번 비교다.
 * 다른 곳은 색인을 쓰는데 여기만 빠져 있었다.
 */
const updateMempool = uTxOutList => {
  const unspent = indexByOutpoint(uTxOutList);

  mempool = mempool.filter(tx =>
    tx.txIns.every(txIn => unspent.has(keyOf(txIn.txOutId, txIn.txOutIndex)))
  );
};

// Mempool 에 추가하기
const addToMempool = (tx, uTxOutList) => {
  if (mempool.length >= MAX_MEMPOOL_SIZE) {
    throw Error(`The mempool is full (${MAX_MEMPOOL_SIZE} txs). Try again later.`);
  }
  if (!validateTx(tx, uTxOutList)) {
    throw Error("This tx is invalid. Will not add it to pool");
  } else if (!isTxValidForPool(tx, mempool)) {
    throw Error("This tx is not valid for the pool. Will not add it.");
  }
  mempool.push(tx);
};

/*
 * 블록에 담을 트랜잭션을 고른다.
 *
 * 예전에는 mempool 전체를 그대로 담았다. 블록 크기 제한이 없으니 스팸을
 * 막을 수 없었고, 수수료를 더 낸다고 먼저 담기지도 않았다.
 *
 * 실제 비트코인은 바이트당 수수료로 줄을 세운다. 여기서는 트랜잭션 크기를
 * 재지 않으므로 입력 개수를 크기의 대용으로 쓴다 — 입력이 많을수록 서명
 * 검증 비용도 커지기 때문이다.
 */
const selectTxsForBlock = (candidates, uTxOutList, limit) => {
  if (limit <= 0) {
    return [];
  }
  return candidates
    .map(tx => ({
      tx,
      feeRate: getTxFee(tx, uTxOutList) / Math.max(1, tx.txIns.length)
    }))
    .sort((a, b) => b.feeRate - a.feeRate)
    .slice(0, limit)
    .map(entry => entry.tx);
};

module.exports = {
  addToMempool,
  getMempool,
  updateMempool,
  selectTxsForBlock,
  MAX_MEMPOOL_SIZE
};
