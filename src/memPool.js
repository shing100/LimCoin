const Transactions = require("./transactions");

const { validateTx, getTxFee, updateUTxOuts, isSpendable } = Transactions;
const { keyOf, indexByOutpoint } = require("./utxo");

// mempool 에 무한정 쌓이지 않게 상한을 둔다.
// 예전에는 제한이 없어 스팸 트랜잭션으로 메모리를 밀어낼 수 있었다.
const MAX_MEMPOOL_SIZE = 500;

let mempool = [];

/*
 * mempool 이 바뀔 때 알려 줄 곳. blockchain.js 가 저장을 걸어 둔다.
 * 여기서 직접 저장하지 않는 것은, 이 모듈이 저장소나 체인을 몰라야 하기
 * 때문이다 — 그래야 테스트가 디스크 없이 돈다.
 */
let listeners = [];
const onChange = listener => {
  listeners.push(listener);
};
const notifyChange = () => {
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      console.log(`mempool 변경 알림 처리 중 문제: ${e.message}`);
    }
  }
};

/*
 * mempool 사본.
 *
 * 얕은 복사다. 배열만 새로 만들고 트랜잭션 객체는 그대로 넘긴다.
 * 트랜잭션은 서명이 끝난 순간부터 아무도 고치지 않는다(고치면 id 가
 * 달라져 검증에서 떨어진다). 그러니 지켜야 할 것은 "밖에서 pool 에
 * 넣거나 뺄 수 없다"는 것뿐이고, 그건 배열만 새로 만들면 된다.
 *
 * 예전에는 _.cloneDeep 이었다. /info 는 지갑과 익스플로러가 4초마다
 * 부르는데, 500건짜리 mempool 을 통째로 복제하는 데 1.8ms 가 들었다.
 */
const getMempool = () => mempool.slice();

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

  const before = mempool.length;
  mempool = mempool.filter(tx =>
    tx.txIns.every(txIn => unspent.has(keyOf(txIn.txOutId, txIn.txOutIndex)))
  );
  if (mempool.length !== before) {
    notifyChange();
  }
};

/*
 * "지금 쓸 수 있는" UTxOut 집합.
 *
 * 확정된 UTxOut 에 mempool 이 만든 출력을 더하고, mempool 이 이미 쓴 것을
 * 뺀 것이다. 이게 있어야 아직 블록에 담기지 않은 출력을 이어서 쓸 수 있다
 * (chained send — 확인을 기다리지 않고 연달아 보내는 것).
 */
const getSpendableUTxOuts = uTxOutList => updateUTxOuts(mempool, uTxOutList);

/*
 * spendHeight 높이에서 실제로 쓸 수 있는 것만 남긴다.
 * 갓 채굴한 코인베이스는 아직 묻히지 않아 빠진다.
 */
const getMatureUTxOuts = (uTxOutList, spendHeight) =>
  uTxOutList.filter(uTxOut => isSpendable(uTxOut, spendHeight));

// Mempool 에 추가하기
/*
 * spendHeight 는 이 트랜잭션이 담길 블록의 높이다. 코인베이스 출력이
 * 충분히 묻혔는지 보려면 필요하다 — 지금 mempool 에 넣어도 되는지는
 * "다음 블록에서 쓸 수 있는가"와 같은 물음이다.
 */
const addToMempool = (tx, uTxOutList, spendHeight) => {
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
  if (!validateTx(tx, getSpendableUTxOuts(uTxOutList), undefined, spendHeight)) {
    throw Error("This tx is invalid. Will not add it to pool");
  }
  mempool.push(tx);
  notifyChange();
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
const selectTxsForBlock = (candidates, uTxOutList, limit, spendHeight) => {
  if (limit <= 0) {
    return [];
  }

  /*
   * 아직 묻히지 않은 코인베이스를 쓰는 것은 담지 않는다.
   *
   * mempool 에 들어올 때 성숙도를 보지만, 그 뒤 체인이 갈라져 짧아지면
   * 다시 어려질 수 있다. 그대로 담으면 스스로 만든 블록이 검증에서
   * 떨어진다. 빼기만 하고 mempool 에는 남겨 둔다 — 블록이 더 쌓이면
   * 그때 담기면 된다.
   *
   * 확정 집합에 없는 입력은 mempool 이 만든 출력이다. mempool 에는
   * 코인베이스가 없으므로 성숙도를 따질 일이 없다.
   */
  const confirmed = indexByOutpoint(uTxOutList);
  const mature = candidates.filter(tx =>
    tx.txIns.every(txIn => {
      const source = confirmed.get(keyOf(txIn.txOutId, txIn.txOutIndex));
      return source === undefined || isSpendable(source, spendHeight);
    })
  );
  candidates = mature;

  // 부모가 만든 출력을 자식이 쓰는 경우가 있으므로, 수수료율만 보고 자를 수
  // 없다. 부모 없이 자식만 담기면 그 블록은 검증에서 떨어진다.
  const producedBy = new Map(); // outpoint -> 그것을 만든 tx

  /*
   * 수수료를 구하려면 입력이 가리키는 출력을 되짚어야 한다. 확정된 것만
   * 보면 부모가 mempool 에 있는 자식은 입력이 "없는 출력"이 되어 수수료가
   * 크게 음수로 나오고, 줄 세우기가 뒤집힌다. 후보들이 만든 출력도 함께
   * 넣어 둔다.
   */
  const sources = indexByOutpoint(uTxOutList);
  for (const tx of candidates) {
    tx.txOuts.forEach((txOut, index) => {
      producedBy.set(keyOf(tx.id, index), tx);
      sources.set(keyOf(tx.id, index), txOut);
    });
  }

  const byFeeRate = candidates
    .map(tx => ({
      tx,
      feeRate: getTxFee(tx, sources) / Math.max(1, tx.txIns.length)
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

/*
 * 권장 수수료 (입력 하나당).
 *
 * 블록에는 코인베이스를 뺀 MAX_TXS_PER_BLOCK - 1 건이 들어가고, 수수료율
 * (수수료 / 입력 수)이 높은 순으로 담긴다. mempool 에 그보다 적게 있으면
 * 다음 블록에 자리가 있으므로 바닥값이면 된다. 그보다 많으면 담기는
 * 마지막 자리의 수수료율보다 조금 높아야 한다.
 *
 * 지갑이 수수료를 사용자에게 통째로 맡기고 있었다. 비트코인 코어의
 * estimatesmartfee 처럼 과거 블록을 보는 것은 아니고, 지금 mempool 만 본다.
 */
const MIN_FEE_PER_INPUT = 1000; // = dust. 이보다 작은 수수료는 의미가 없다

const estimateFee = (uTxOutList, blockCapacity) => {
  const sources = indexByOutpoint(uTxOutList);
  for (const tx of mempool) {
    tx.txOuts.forEach((txOut, index) => sources.set(keyOf(tx.id, index), txOut));
  }
  const rates = mempool
    .map(tx => getTxFee(tx, sources) / Math.max(1, tx.txIns.length))
    .sort((a, b) => b - a);

  const roomLeft = blockCapacity - rates.length;
  if (roomLeft > 0) {
    return {
      perInput: MIN_FEE_PER_INPUT,
      congested: false,
      mempoolSize: rates.length,
      blockCapacity
    };
  }
  // 담길 마지막 자리의 수수료율. 그보다 1 lm 만 높으면 그 자리를 밀어낸다.
  const cutoff = rates[blockCapacity - 1];
  return {
    perInput: Math.max(MIN_FEE_PER_INPUT, Math.ceil(cutoff) + 1),
    congested: true,
    mempoolSize: rates.length,
    blockCapacity
  };
};

module.exports = {
  estimateFee,
  MIN_FEE_PER_INPUT,
  addToMempool,
  getSpendableUTxOuts,
  getMatureUTxOuts,
  onChange,
  getMempool,
  updateMempool,
  selectTxsForBlock,
  MAX_MEMPOOL_SIZE
};
