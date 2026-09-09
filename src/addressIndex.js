/**
 * 주소별 색인.
 *
 * 지금까지 "이 주소가 얽힌 트랜잭션"을 알려면 체인 전체를 훑어야 했다.
 * 지갑도 익스플로러도 각자 블록을 받아다 자기 쪽에서 훑고 있었고,
 * 그러다 보니
 *
 *  - 지갑 내역이 "최근 500블록"으로 잘렸다
 *  - 익스플로러 주소 페이지는 잔액만 보여 줄 수 있었다
 *  - 같은 계산을 노드/지갑/익스플로러가 따로따로 했다
 *
 * 노드가 블록을 붙일 때 한 번만 갱신해 두면 셋 다 해결된다.
 *
 * 트랜잭션의 "보낸 금액"은 입력이 가리키는 이전 출력을 되짚어야 알 수 있다.
 * 그 되짚기는 블록을 적용하기 *전*의 UTxOut 집합에서만 가능하므로,
 * applyBlock 은 반드시 uTxOuts 를 갱신하기 전에 불러야 한다.
 */
const { keyOf } = require("./utxo");

// address -> [{ txId, blockIndex, timestamp, received, spent }] (오래된 것부터)
let byAddress = new Map();

const reset = () => {
  byAddress = new Map();
};

const record = (address, entry) => {
  const list = byAddress.get(address);
  if (list === undefined) {
    byAddress.set(address, [entry]);
  } else {
    list.push(entry);
  }
};

/**
 * 블록 하나를 색인에 반영한다.
 * uTxOutsBefore 는 이 블록을 적용하기 전의 UTxOut 목록이어야 한다.
 */
const applyBlock = (block, uTxOutsBefore) => {
  // 이 블록 안에서 만들어진 출력도 같은 블록의 다음 트랜잭션이 쓸 수 있으므로
  // 되짚기 표에 함께 넣는다.
  const outpoints = new Map();
  for (const uTxOut of uTxOutsBefore) {
    outpoints.set(keyOf(uTxOut.txOutId, uTxOut.txOutIndex), uTxOut);
  }

  for (const tx of block.data || []) {
    const touched = new Map(); // address -> { received, spent }

    const isCoinbase = tx.txIns.length === 1 && tx.txIns[0].txOutId === "";
    // 이 트랜잭션의 전체 출력 합. 지갑이 "내가 받은 몫"과 견줘서
    // 출력이 전부 내 주소였는지(= 본인 이체) 가릴 수 있게 담아 둔다.
    const outputTotal = tx.txOuts.reduce((sum, txOut) => sum + txOut.amount, 0);

    const bump = (address, field, amount) => {
      const entry = touched.get(address) || { received: 0, spent: 0 };
      entry[field] += amount;
      touched.set(address, entry);
    };

    for (const txIn of tx.txIns) {
      const source = outpoints.get(keyOf(txIn.txOutId, txIn.txOutIndex));
      if (source !== undefined) {
        bump(source.address, "spent", source.amount);
      }
    }

    tx.txOuts.forEach((txOut, index) => {
      bump(txOut.address, "received", txOut.amount);
      outpoints.set(keyOf(tx.id, index), {
        txOutId: tx.id,
        txOutIndex: index,
        address: txOut.address,
        amount: txOut.amount
      });
    });

    for (const [address, { received, spent }] of touched) {
      record(address, {
        txId: tx.id,
        blockIndex: block.index,
        timestamp: block.timestamp,
        coinbase: isCoinbase,
        outputTotal,
        received,
        spent
      });
    }
  }
};

// 체인 전체로 색인을 다시 만든다. 기동 시와 체인 교체 시에 쓴다.
const rebuild = (chain, applyToUTxOuts) => {
  reset();
  let uTxOuts = [];
  for (const block of chain) {
    applyBlock(block, uTxOuts);
    uTxOuts = applyToUTxOuts(block, uTxOuts);
    if (uTxOuts === null) {
      // 여기까지만 색인한다. 부르는 쪽이 체인을 자를 것이다.
      break;
    }
  }
};

/**
 * blockIndex 가 cutBlockIndex 이상인 기록을 걷어 낸다 (체인 교체용).
 *
 * 예전에는 체인이 갈라질 때마다 색인을 통째로 다시 만들었다. 갈라지는 건
 * 보통 마지막 한두 블록인데 체인 전체를 다시 훑는 셈이었다.
 *
 * 기록은 주소마다 블록 순서대로 쌓이므로, 뒤에서부터 자르면 된다.
 */
const rollbackTo = cutBlockIndex => {
  for (const [address, list] of byAddress) {
    let end = list.length;
    while (end > 0 && list[end - 1].blockIndex >= cutBlockIndex) {
      end--;
    }
    if (end === 0) {
      byAddress.delete(address);
    } else if (end < list.length) {
      list.length = end;
    }
  }
};

/**
 * 주소의 트랜잭션 내역. 최신 것부터.
 */
const getTransactions = (address, limit = 50, offset = 0) => {
  const all = byAddress.get(address) || [];
  const newestFirst = all.slice().reverse();
  return {
    total: all.length,
    transactions: newestFirst.slice(offset, offset + limit)
  };
};

// 개수만 필요할 때. getTransactions 는 목록을 뒤집느라 배열을 통째로 복사한다.
const getTransactionCount = address => (byAddress.get(address) || []).length;

const hasAddress = address => byAddress.has(address);

const getIndexedAddressCount = () => byAddress.size;

module.exports = {
  reset,
  applyBlock,
  rebuild,
  rollbackTo,
  getTransactions,
  getTransactionCount,
  hasAddress,
  getIndexedAddressCount
};
