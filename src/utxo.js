/**
 * UTxOut 색인.
 *
 * 지금까지는 UTxOut 을 그냥 배열로 들고 다니며 매번 훑었다.
 *
 *   findUTxOut  : uTxOutList.find(...)        O(n), txIn 하나마다 호출
 *   updateUTxOuts: filter + findUTxOut        O(n * m)
 *   getBalance  : filter + map + sum          O(n)
 *
 * 블록이 쌓일수록 검증 비용이 제곱으로 늘어난다. 배열이라는 겉모습은
 * 그대로 두고(직렬화와 기존 API 가 그것에 기대고 있다), 훑기 전에 한 번만
 * 색인을 만들어 쓴다.
 */

// UTxOut 을 가리키는 키. 비트코인의 outpoint 에 해당한다.
const keyOf = (txOutId, txOutIndex) => `${txOutId}:${txOutIndex}`;

const outpointKey = uTxOut => keyOf(uTxOut.txOutId, uTxOut.txOutIndex);

// outpoint -> UTxOut
const indexByOutpoint = uTxOutList => {
  const index = new Map();
  for (const uTxOut of uTxOutList) {
    index.set(outpointKey(uTxOut), uTxOut);
  }
  return index;
};

// 주소 -> 잔액 합계
const indexByAddress = uTxOutList => {
  const index = new Map();
  for (const uTxOut of uTxOutList) {
    index.set(uTxOut.address, (index.get(uTxOut.address) || 0) + uTxOut.amount);
  }
  return index;
};

module.exports = { keyOf, outpointKey, indexByOutpoint, indexByAddress };
