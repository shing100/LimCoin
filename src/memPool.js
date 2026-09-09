const Transactions = require("./transactions");

const {
  validateTx, getTxFee, getTxSize, updateUTxOuts, isSpendable, MIN_RELAY_FEE_RATE
} = Transactions;
const { keyOf, indexByOutpoint } = require("./utxo");
const { estimateTxSize } = require("./serialization");

/*
 * mempool 상한.
 *
 * 예전에는 "500건"이 유일한 상한이었다. 건수로 재면 출력이 백 개인
 * 트랜잭션도 한 건이라, 같은 건수로 메모리를 몇 배씩 쓸 수 있다. 진짜
 * 비용은 바이트다. 건수 상한은 안전판으로 남겨 둔다.
 *
 * 가득 차면 수수료율이 낮은 것부터 밀어낸다 — 예전에는 그냥 거절했다.
 * 그러면 값싼 트랜잭션이 먼저 들어와 자리를 차지한 뒤로는 아무리 비싼
 * 트랜잭션도 들어올 수 없었다.
 */
const positiveEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
// 비트코인의 -maxmempool 처럼 노드마다 조절할 수 있다
const MAX_MEMPOOL_BYTES = positiveEnv("LIMCOIN_MAX_MEMPOOL_BYTES", 5000000);
const MAX_MEMPOOL_SIZE = positiveEnv("LIMCOIN_MAX_MEMPOOL_TXS", 5000);

let mempool = [];

/*
 * 트랜잭션마다 크기와 수수료를 재 두는 표.
 *
 * 둘 다 트랜잭션이 정해진 순간 고정된다(입력이 가리키는 금액은 변하지
 * 않는다). 고를 때마다 다시 재면 mempool 크기에 비례하는 일을 매번 한다.
 */
const meta = new Map();
const metaOf = tx => meta.get(tx.id) || { size: getTxSize(tx), fee: 0 };
const poolBytes = () => mempool.reduce((sum, tx) => sum + metaOf(tx).size, 0);

/*
 * mempool 이 바뀔 때 알려 줄 곳. blockchain.js 가 저장을 걸어 둔다.
 * 여기서 직접 저장하지 않는 것은, 이 모듈이 저장소나 체인을 몰라야 하기
 * 때문이다 — 그래야 테스트가 디스크 없이 돈다.
 */
let listeners = [];
// 바뀔 때마다 1씩 오른다. "그 사이에 바뀌었나"를 싸게 알 수 있다.
let version = 0;
// 돌려주는 함수를 부르면 등록이 풀린다 (채굴처럼 잠깐만 듣는 쪽이 쓴다)
const onChange = listener => {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter(other => other !== listener);
  };
};
const getVersion = () => version;
const notifyChange = () => {
  version++;
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

/*
 * 블록이 붙은 뒤, 더는 유효하지 않은 트랜잭션을 pool 에서 뺀다.
 *
 * 예전에는 txIn 마다 UTxOut 배열 전체를 선형으로 훑었다.
 * mempool 500건 x UTxOut 2만개면 블록 하나마다 천만 번 비교다.
 * 다른 곳은 색인을 쓰는데 여기만 빠져 있었다.
 */
const updateMempool = uTxOutList => {
  /*
   * 확정된 출력에, 남기기로 한 트랜잭션이 만든 출력을 더해 가며 순서대로 본다.
   *
   * 확정된 것만 보면 부모가 아직 mempool 에 있는 자식(이어 쓴 것)은 블록이
   * 하나 붙을 때마다 — 그 블록과 아무 상관이 없어도 — 조용히 버려졌다.
   * mempool 은 들어온 순서라 부모가 자식보다 앞에 있으므로 한 번 훑으면 된다.
   * 부모가 떨어지면 그 출력이 표에 안 올라가 자식도 함께 떨어진다.
   */
  const available = indexByOutpoint(uTxOutList);
  const kept = [];
  for (const tx of mempool) {
    if (tx.txIns.every(txIn => available.has(keyOf(txIn.txOutId, txIn.txOutIndex)))) {
      kept.push(tx);
      tx.txOuts.forEach((txOut, index) => available.set(keyOf(tx.id, index), txOut));
    }
  }
  const before = mempool.length;
  mempool = kept;
  if (mempool.length !== before) {
    const alive = new Set(mempool.map(tx => tx.id));
    for (const id of [...meta.keys()]) {
      if (!alive.has(id)) {
        meta.delete(id);
      }
    }
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
const addToMempool = (tx, uTxOutList, spendHeight, mtp) => {
  /*
   * 바꿔치기(RBF)를 먼저 살핀다.
   *
   * 같은 출력을 쓰려는 트랜잭션이 이미 있으면 이중지불이다. 다만 보낸
   * 사람이 수수료를 더 얹어 다시 보내는 것은 받아 준다 — 수수료를 적게
   * 매겨 몇 시간씩 묶이는 것을 푸는 길이 그것뿐이다.
   *
   * 검증은 "밀려날 것들을 뺀" 상태에서 해야 한다. 그러지 않으면 그 출력이
   * 이미 쓰였다는 이유로 검증에서 먼저 떨어져 바꿔치기가 아예 안 된다.
   *
   * 비트코인은 sequence 로 "이 트랜잭션은 바꿔도 된다"를 미리 밝히게 했다
   * (BIP125). 여기에는 sequence 가 없으므로 언제나 바꿀 수 있다 — 비트코인
   * 코어도 지금은 그것을 기본값으로 한다(full-RBF).
   */
  const conflicts = conflictingTxs(tx);
  const evicted = conflicts.length > 0 ? withDescendants(conflicts) : [];
  const doomed = new Set(evicted.map(other => other.id));
  const survivors = mempool.filter(other => !doomed.has(other.id));
  const spendable = updateUTxOuts(survivors, uTxOutList);

  if (!validateTx(tx, spendable, undefined, spendHeight, mtp)) {
    throw Error("This tx is invalid. Will not add it to pool");
  }

  const size = getTxSize(tx);
  const fee = getTxFee(tx, indexByOutpoint(spendable));
  const feeRate = fee / size;
  if (feeRate < MIN_RELAY_FEE_RATE) {
    throw Error(
      `수수료가 너무 낮습니다: ${fee} lm / ${size}바이트 = ${feeRate.toFixed(2)} lm/byte ` +
        `(최소 ${MIN_RELAY_FEE_RATE}). GET /fees 를 보세요.`
    );
  }

  if (conflicts.length > 0) {
    checkReplacement({ size, fee, feeRate }, conflicts, evicted);
    mempool = survivors;
    for (const id of doomed) {
      meta.delete(id);
    }
  }

  makeRoomFor(size, feeRate);

  mempool.push(tx);
  meta.set(tx.id, { size, fee });
  notifyChange();
};

// 이 트랜잭션과 같은 출력을 쓰려는 mempool 트랜잭션들
const conflictingTxs = tx => {
  const wanted = new Set(tx.txIns.map(txIn => keyOf(txIn.txOutId, txIn.txOutIndex)));
  return mempool.filter(other =>
    other.txIns.some(txIn => wanted.has(keyOf(txIn.txOutId, txIn.txOutIndex)))
  );
};

// 이 트랜잭션들이 만든 출력을 쓰는 mempool 트랜잭션까지 모두 (자기 자신 포함)
const withDescendants = txs => {
  const chosen = new Map(txs.map(tx => [tx.id, tx]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const tx of mempool) {
      if (chosen.has(tx.id)) {
        continue;
      }
      if (tx.txIns.some(txIn => chosen.has(txIn.txOutId))) {
        chosen.set(tx.id, tx);
        grew = true;
      }
    }
  }
  return [...chosen.values()];
};

// 바꿔치기(RBF) 규칙. 통과하지 못하면 던진다.
const MAX_REPLACED = 100;

const checkReplacement = ({ size, fee, feeRate }, conflicts, evicted) => {
  if (evicted.length > MAX_REPLACED) {
    throw Error(`한 번에 ${MAX_REPLACED}건을 넘게 밀어낼 수 없습니다 (${evicted.length}건)`);
  }
  const replacedFee = evicted.reduce((sum, other) => sum + metaOf(other).fee, 0);
  const worstRate = Math.max(...conflicts.map(other => metaOf(other).fee / metaOf(other).size));

  // 수수료율이 더 높아야 한다 — 크기만 키워 총액을 맞춘 것은 자리를 더 먹는다
  if (feeRate <= worstRate) {
    throw Error(
      `바꾸려면 수수료율이 더 높아야 합니다 (${feeRate.toFixed(2)} <= ${worstRate.toFixed(2)} lm/byte)`
    );
  }
  /*
   * 밀려나는 것들의 수수료 합보다 많이 내야 하고, 자기가 쓰는 대역폭 값도
   * 따로 내야 한다. 이 조건이 없으면 1 lm 씩 올리며 같은 자리를 무한히
   * 다시 쓰게 만들어 망 전체에 릴레이를 시킬 수 있다.
   */
  const required = replacedFee + size * MIN_RELAY_FEE_RATE;
  if (fee < required) {
    throw Error(
      `바꾸려면 수수료가 ${required} lm 이상이어야 합니다 ` +
        `(밀려나는 ${replacedFee} + 대역폭 ${size * MIN_RELAY_FEE_RATE}, 낸 값 ${fee})`
    );
  }
};

/*
 * 자리를 만든다. 가득 찼으면 수수료율이 낮은 것부터(자식까지 함께) 밀어낸다.
 * 새로 들어오려는 것이 밀어낼 것보다 싸면 그냥 거절한다.
 */
const makeRoomFor = (size, feeRate) => {
  while (poolBytes() + size > MAX_MEMPOOL_BYTES || mempool.length + 1 > MAX_MEMPOOL_SIZE) {
    if (mempool.length === 0) {
      throw Error(`트랜잭션이 너무 큽니다 (${size}바이트, 상한 ${MAX_MEMPOOL_BYTES})`);
    }
    let worst = mempool[0];
    let worstRate = Infinity;
    for (const other of mempool) {
      const rate = metaOf(other).fee / metaOf(other).size;
      if (rate < worstRate) {
        worstRate = rate;
        worst = other;
      }
    }
    if (feeRate <= worstRate) {
      throw Error(
        `mempool 이 가득 찼습니다. 수수료율이 ${worstRate.toFixed(2)} lm/byte 보다 높아야 합니다.`
      );
    }
    const gone = new Set(withDescendants([worst]).map(other => other.id));
    mempool = mempool.filter(other => !gone.has(other.id));
    for (const id of gone) {
      meta.delete(id);
    }
  }
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
const selectTxsForBlock = (candidates, uTxOutList, limits, spendHeight) => {
  const maxTxs = typeof limits === "number" ? limits : limits.maxTxs;
  const maxBytes = typeof limits === "number" ? Infinity : limits.maxBytes;
  if (maxTxs <= 0 || maxBytes <= 0) {
    return [];
  }

  /*
   * 아직 묻히지 않은 코인베이스를 쓰는 것은 담지 않는다.
   *
   * mempool 에 들어올 때 성숙도를 보지만, 그 뒤 체인이 갈라져 짧아지면
   * 다시 어려질 수 있다. 그대로 담으면 스스로 만든 블록이 검증에서
   * 떨어진다. 빼기만 하고 mempool 에는 남겨 둔다 — 블록이 더 쌓이면
   * 그때 담기면 된다.
   */
  const confirmed = indexByOutpoint(uTxOutList);
  candidates = candidates.filter(tx =>
    tx.txIns.every(txIn => {
      const source = confirmed.get(keyOf(txIn.txOutId, txIn.txOutIndex));
      return source === undefined || isSpendable(source, spendHeight);
    })
  );

  // 부모가 만든 출력을 자식이 쓰는 경우가 있으므로 수수료율만 보고 자를 수
  // 없다. 부모 없이 자식만 담기면 그 블록은 검증에서 떨어진다.
  const producedBy = new Map(); // outpoint -> 그것을 만든 tx
  const sources = indexByOutpoint(uTxOutList);
  for (const tx of candidates) {
    tx.txOuts.forEach((txOut, index) => {
      producedBy.set(keyOf(tx.id, index), tx);
      sources.set(keyOf(tx.id, index), txOut);
    });
  }

  const sizeOf = new Map(candidates.map(tx => [tx.id, getTxSize(tx)]));
  const feeOf = new Map(candidates.map(tx => [tx.id, getTxFee(tx, sources)]));

  // 아직 담기지 않은 조상들 (자기 자신 포함)
  const ancestorsOf = tx => {
    const found = new Map();
    const walk = current => {
      if (found.has(current.id)) {
        return;
      }
      found.set(current.id, current);
      for (const txIn of current.txIns) {
        const parent = producedBy.get(keyOf(txIn.txOutId, txIn.txOutIndex));
        if (parent !== undefined) {
          walk(parent);
        }
      }
    };
    walk(tx);
    return [...found.values()];
  };

  /*
   * 묶음(조상 포함) 수수료율로 줄을 세운다.
   *
   * 수수료를 적게 매긴 부모가 mempool 에 묶여 있으면, 받는 쪽이 그 출력을
   * 쓰면서 수수료를 두둑이 얹어 부모까지 끌어올릴 수 있다(CPFP). 자기
   * 수수료율만 보면 부모가 싸다는 이유로 둘 다 뒤로 밀린다.
   */
  const scored = candidates
    .map(tx => {
      const package_ = ancestorsOf(tx);
      const fee = package_.reduce((sum, member) => sum + feeOf.get(member.id), 0);
      const size = package_.reduce((sum, member) => sum + sizeOf.get(member.id), 0);
      return { tx, score: fee / size };
    })
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const taken = new Set();
  let bytes = 0;

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
    const size = sizeOf.get(tx.id);
    if (selected.length >= maxTxs || bytes + size > maxBytes) {
      return false;
    }
    selected.push(tx);
    taken.add(tx.id);
    bytes += size;
    return true;
  };

  for (const { tx } of scored) {
    if (selected.length >= maxTxs) {
      break;
    }
    // 담다가 자리가 모자라면 이 갈래는 통째로 버린다 — 부모 없는 자식이
    // 남으면 안 되므로 실패한 갈래에서 새로 담은 것을 되돌린다.
    const before = selected.length;
    const bytesBefore = bytes;
    if (!take(tx, new Set())) {
      for (const rolledBack of selected.splice(before)) {
        taken.delete(rolledBack.id);
      }
      bytes = bytesBefore;
    }
  }

  return selected;
};

/*
 * 권장 수수료율 (lm/byte).
 *
 * 다음 블록에 담기려면 얼마를 내야 하는가. 블록은 바이트로 차므로,
 * mempool 을 수수료율 높은 순으로 세워 놓고 블록 한 개 분량을 채운 뒤
 * 잘리는 자리의 값을 본다. 그만큼 차지 않았으면 바닥값이면 된다.
 *
 * 비트코인 코어의 estimatesmartfee 처럼 과거 블록의 통계를 보는 것은
 * 아니고, 지금 mempool 만 본다.
 */
const estimateFee = (uTxOutList, blockBytes) => {
  const sources = indexByOutpoint(uTxOutList);
  for (const tx of mempool) {
    tx.txOuts.forEach((txOut, index) => sources.set(keyOf(tx.id, index), txOut));
  }
  const entries = mempool
    .map(tx => {
      const size = getTxSize(tx);
      return { size, rate: getTxFee(tx, sources) / size };
    })
    .sort((a, b) => b.rate - a.rate);

  const mempoolBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const typicalBytes = estimateTxSize(1, 2);

  const answer = (perByte, congested) => ({
    perByte,
    // 입력 하나, 출력 둘짜리 보통 트랜잭션이 내야 할 값 — 지갑이 바로 쓴다
    typicalTx: { bytes: typicalBytes, fee: Math.ceil(perByte * typicalBytes) },
    congested,
    mempoolSize: mempool.length,
    mempoolBytes,
    blockBytes
  });

  if (mempoolBytes < blockBytes) {
    return answer(MIN_RELAY_FEE_RATE, false);
  }
  // 블록 한 개 분량을 채우고 잘리는 자리의 수수료율
  let filled = 0;
  let cutoff = MIN_RELAY_FEE_RATE;
  for (const entry of entries) {
    cutoff = entry.rate;
    filled += entry.size;
    if (filled >= blockBytes) {
      break;
    }
  }
  return answer(Math.max(MIN_RELAY_FEE_RATE, Math.floor(cutoff) + 1), true);
};

module.exports = {
  estimateFee,
  MAX_MEMPOOL_BYTES,
  addToMempool,
  getSpendableUTxOuts,
  getMatureUTxOuts,
  onChange,
  getVersion,
  getMempool,
  updateMempool,
  selectTxsForBlock,
  poolBytes,
  MAX_MEMPOOL_SIZE
};
