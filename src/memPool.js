const _ = require("lodash"),
  Transactions = require("./transactions");

const { validateTx, getTxFee } = Transactions;

// mempool 에 무한정 쌓이지 않게 상한을 둔다.
// 예전에는 제한이 없어 스팸 트랜잭션으로 메모리를 밀어낼 수 있었다.
const MAX_MEMPOOL_SIZE = 500;

let mempool = [];

const getMempool = () => _.cloneDeep(mempool);

const getTxInsInPool = mempool => {
  return _(mempool).map(tx => tx.txIns).flatten().value();
};

const isTxValidForPool = (tx, mempool) => {
  const txInsInPool = getTxInsInPool(mempool);

  const isTxInAlreadyInPool = (txIns, txIn) => {
    return _.find(txIns, txInInPool => {
      return (
        txIn.txOutIndex === txInInPool.txOutIndex &&
      txIn.txOutId === txInInPool.txOutId
      );
    });
  };

  for (const txIn of tx.txIns) {
    if (isTxInAlreadyInPool(txInsInPool, txIn)) {
      return false;
    }
  }
  return true;
};

const hasTxIn = (txIn, uTxOutList) => {
  const foundTxIn = uTxOutList.find(
    uTxO => uTxO.txOutId === txIn.txOutId && uTxO.txOutIndex === txIn.txOutIndex
  );

  return foundTxIn !== undefined;
};

// update Mempool
const updateMempool = uTxOutList => {
  const invalidTxs = [];

  for (const tx of mempool) {
    for (const txIn of tx.txIns) {
      if (!hasTxIn(txIn, uTxOutList)) {
        invalidTxs.push(tx);
        break;
      }
    }
  }

  if (invalidTxs.length > 0) {
    mempool = _.without(mempool, ...invalidTxs);
  }
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
