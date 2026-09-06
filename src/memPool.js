const _ = require("lodash"),
  Transactions = require("./transactions");

const { validateTx, getTxFee, updateUTxOuts } = Transactions;
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

/*
 * "지금 쓸 수 있는" UTxOut 집합.
 *
 * 확정된 UTxOut 에 mempool 이 만든 출력을 더하고, mempool 이 이미 쓴 것을
 * 뺀 것이다. 이게 있어야 아직 블록에 담기지 않은 출력을 이어서 쓸 수 있다
 * (chained send — 확인을 기다리지 않고 연달아 보내는 것).
 */
const getSpendableUTxOuts = uTxOutList => updateUTxOuts(mempool, uTxOutList);

// Mempool 에 추가하기
const addToMempool = (tx, uTxOutList) => {
  if (mempool.length >= MAX_MEMPOOL_SIZE) {
    throw Error(`The mempool is full (${MAX_MEMPOOL_SIZE} txs). Try again later.`);
  }
  /*
   * 이중지불 검사를 먼저 한다.
   *
   * 아래 validateTx 도 결국 걸러 내기는 한다 — getSpendableUTxOuts 가
   * mempool 이 이미 쓴 outpoint 를 빼 주기 때문이다. 다만 그때의 이유는
   * "참조하는 출력이 없다"가 되어, 왜 거부됐는지 알기 어렵다.
   */
  if (!isTxValidForPool(tx, mempool)) {
    throw Error("This tx is not valid for the pool. Will not add it.");
  }
  // 확정된 것뿐 아니라 mempool 이 만든 출력도 볼 수 있어야 한다
  if (!validateTx(tx, getSpendableUTxOuts(uTxOutList))) {
    throw Error("This tx is invalid. Will not add it to pool");
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

  // 부모가 만든 출력을 자식이 쓰는 경우가 있으므로, 수수료율만 보고 자를 수
  // 없다. 부모 없이 자식만 담기면 그 블록은 검증에서 떨어진다.
  const confirmed = indexByOutpoint(uTxOutList);
  const producedBy = new Map(); // outpoint -> 그것을 만든 tx
  for (const tx of candidates) {
    tx.txOuts.forEach((txOut, index) => producedBy.set(keyOf(tx.id, index), tx));
  }

  const byFeeRate = candidates
    .map(tx => ({
      tx,
      feeRate: getTxFee(tx, confirmed) / Math.max(1, tx.txIns.length)
    }))
    .sort((a, b) => b.feeRate - a.feeRate)
    .map(entry => entry.tx);

  const selected = [];
  const taken = new Set();

  // 부모를 먼저 담고 자식을 담는다. 자리가 모자라면 그 갈래는 통째로 뺀다.
  const take = (tx, seen) => {
    if (taken.has(tx.id)) {
      return true;
    }
    if (seen.has(tx.id)) {
      return false; // 순환 참조는 있을 수 없지만 방어해 둔다
    }
    seen.add(tx.id);

    for (const txIn of tx.txIns) {
      const parent = producedBy.get(keyOf(txIn.txOutId, txIn.txOutIndex));
      if (parent !== undefined && !take(parent, seen)) {
        return false;
      }
    }
    if (selected.length >= limit) {
      return false;
    }
    selected.push(tx);
    taken.add(tx.id);
    return true;
  };

  for (const tx of byFeeRate) {
    if (selected.length >= limit) {
      break;
    }
    // 담다가 자리가 모자라면 이 갈래는 통째로 버린다 —
    // 이미 담은 것은 그대로 두되, 부모 없는 자식이 남지 않게 하려면
    // 실패한 갈래에서 새로 담은 것을 되돌려야 한다.
    const before = selected.length;
    if (!take(tx, new Set())) {
      for (const rolledBack of selected.splice(before)) {
        taken.delete(rolledBack.id);
      }
    }
  }

  return selected;
};

module.exports = {
  addToMempool,
  getSpendableUTxOuts,
  getMempool,
  updateMempool,
  selectTxsForBlock,
  MAX_MEMPOOL_SIZE
};
