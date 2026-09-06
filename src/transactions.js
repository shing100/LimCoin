const CryptoJS = require("crypto-js"),
  elliptic = require("elliptic"),
  _ = require("lodash"),
  utils = require("./utils");

const { COIN } = require("./units");
const { keyOf, outpointKey, indexByOutpoint } = require("./utxo");

const ec = new elliptic.ec("secp256k1");

/*
 * 발행 정책. 백서 6장 "Incentive":
 *
 *   "Once a predetermined number of coins have entered circulation, the
 *    incentive can transition entirely to transaction fees and be completely
 *    inflation free."
 *
 * 예전에는 COINBASE_AMOUNT 가 10 으로 고정이라 발행량에 상한이 없었다.
 * 비트코인과 같은 방식으로 일정 블록마다 보조금을 반으로 줄인다.
 * 총 발행량은 210000 * 10 * 2 = 4,200,000 LIM 으로 수렴한다.
 */
const INITIAL_SUBSIDY = 10 * COIN;
const HALVING_INTERVAL = 210000;

// 블록에 담을 수 있는 트랜잭션 수 상한(코인베이스 포함).
// 예전에는 mempool 전체를 그대로 담아서 스팸을 막을 방법이 없었다.
const MAX_TXS_PER_BLOCK = 100;

// 해당 높이의 블록 보조금. 반감이 거듭되면 0 으로 수렴하고,
// 그 뒤로는 백서대로 수수료만 남는다.
/*
 * 높이 height 까지 발행된 총량.
 *
 * 예전에는 /info 가 블록마다 getBlockSubsidy 를 불러 더했다. 체인이
 * 길어질수록 폴링 한 번의 값이 비례해서 커진다. 반감기마다 보조금이
 * 같으므로 구간별로 곱하면 반감 횟수(최대 64번)만큼만 돌면 된다.
 */
const getTotalSupply = height => {
  let total = 0;
  let remaining = height + 1; // 블록 수 (제네시스 포함)
  for (let epoch = 0; remaining > 0 && epoch < 64; epoch++) {
    const subsidy = getBlockSubsidy(epoch * HALVING_INTERVAL);
    if (subsidy === 0) {
      break;
    }
    const count = Math.min(remaining, HALVING_INTERVAL);
    total += subsidy * count;
    remaining -= count;
  }
  return total;
};

const getBlockSubsidy = blockIndex => {
  const halvings = Math.floor(blockIndex / HALVING_INTERVAL);
  if (halvings >= 64) {
    return 0;
  }
  return Math.floor(INITIAL_SUBSIDY / Math.pow(2, halvings));
};

class TxOut {
  constructor(address, amount) {
    this.address = address;
    this.amount = amount;
  }
}

class TxIn {
  // txOutId
  // txOutIndex
  // Signature
}

class Transaction {
  // ID
  // txIns[]
  // txOuts[]
}

class UTxOut {
  constructor(txOutId, txOutIndex, address, amount) {
    this.txOutId = txOutId;
    this.txOutIndex = txOutIndex;
    this.address = address;
    this.amount = amount;
  }
}

// tx id 가져오기
const getTxId = tx => {
  const txInContent = tx.txIns
    .map(txIn => txIn.txOutId + txIn.txOutIndex)
    .reduce((a, b) => a + b, "");

  const txOutContent = tx.txOuts
    .map(txOut => txOut.address + txOut.amount)
    .reduce((a, b) => a + b, "");

  return CryptoJS.SHA256(txInContent + txOutContent).toString();
};

// genesisTx id 값을 알아내기 위한 로그
//console.log(getTxId(genesisTx));

// uTxOuts 가 Map(색인)이면 O(1), 배열이면 예전처럼 훑는다.
const findUTxOut = (txOutId, txOutIndex, uTxOuts) => {
  if (uTxOuts instanceof Map) {
    return uTxOuts.get(keyOf(txOutId, txOutIndex));
  }
  return uTxOuts.find(
    uTxO => uTxO.txOutId === txOutId && uTxO.txOutIndex === txOutIndex
  );
};

const signTxIn = (tx, txInIndex, privateKey, uTxOutList) => {
  const txIn = tx.txIns[txInIndex];
  const dataToSign = tx.id;
  const referencedUTxOut = findUTxOut(
    txIn.txOutId,
    txIn.txOutIndex,
    uTxOutList
  );
  // 참조 TxOut 체크하기
  if (referencedUTxOut === null || referencedUTxOut === undefined) {
    throw Error("Couldn't find the referenced uTxOut, not signing");
  }
  const referencedAddress = referencedUTxOut.address;
  if (getPublicKey(privateKey) !== referencedAddress) {
    return false;
  }
  const key = ec.keyFromPrivate(privateKey, "hex");
  const signature = utils.toHexString(key.sign(dataToSign).toDER());
  return signature;
};

// 공개키 얻어오기
const getPublicKey = privateKey => {
  return ec
    .keyFromPrivate(privateKey, "hex")
    .getPublic()
    .encode("hex");
};

const updateUTxOuts = (newTxs, uTxOutList) => {
  const newUTxOuts = newTxs
    .map(tx =>
      tx.txOuts.map(
        (txOut, index) => new UTxOut(tx.id, index, txOut.address, txOut.amount)
      )
    )
    .reduce((a, b) => a.concat(b), []);

  // 이번 블록에서 쓰여 없어지는 outpoint 들
  const spent = new Set(
    newTxs
      .map(tx => tx.txIns)
      .reduce((a, b) => a.concat(b), [])
      .map(txIn => keyOf(txIn.txOutId, txIn.txOutIndex))
  );

  /*
   * 새 출력을 먼저 붙이고 나서 쓰인 것을 걷어 낸다.
   *
   * 순서가 반대면, 같은 블록 안에서 만들어지고 바로 쓰인 출력이 살아남는다
   * (걷어 낸 뒤에 붙이므로 spent 검사를 피해 간다). 그러면 이미 쓴 코인이
   * UTxOut 집합에 남아 두 번 쓸 수 있게 된다.
   */
  return uTxOutList
    .concat(newUTxOuts)
    .filter(uTxO => !spent.has(outpointKey(uTxO)));
};

// TxIn 구조체 유효성 검사
const isTxInStructureValid = txIn => {
  if (txIn === null) {
    console.log("The txIn appears to be null");
    return false;
  } else if (typeof txIn.signature !== "string") {
    console.log("The txIn doesn't have a valid signature");
    return false;
  } else if (typeof txIn.txOutId !== "string") {
    console.log("The txIn doesn't have a valid txOutId");
    return false;
  } else if (typeof txIn.txOutIndex !== "number") {
    console.log("The txIn doesn't have a valid txOutIndex");
    return false;
  } else {
    return true;
  }
};

// 주소 유효성 검사
const isAddressValid = address => {
  if (address.length !== 130) {
    console.log("The address length is not the expected one");
    return false;
  } else if (address.match("^[a-fA-F0-9]+$") === null) {
    console.log("The address doesn't match the hex patter");
    return false;
  } else if (!address.startsWith("04")) {
    console.log("The address doesn't start with 04");
    return false;
  } else {
    return true;
  }
};

// 금액은 최소 단위(lm) 기준 정수여야 한다.
// 소수를 허용하면 노드마다 반올림이 갈려 합의가 깨진다.
const isAmountValid = amount =>
  typeof amount === "number" &&
  Number.isInteger(amount) &&
  amount > 0 &&
  amount <= Number.MAX_SAFE_INTEGER;

// TxOut 구초체 유효성 검사
const isTxOutStructureValid = txOut => {
  if (txOut === null) {
    return false;
  } else if (typeof txOut.address !== "string") {
    console.log("The txOut doesn't have a valid string as address");
    return false;
  } else if (!isAddressValid(txOut.address)) {
    console.log("The txOut doesn't have a valid address");
    return false;
  } else if (!isAmountValid(txOut.amount)) {
    console.log("The txOut doesn't have a valid amount");
    return false;
  } else {
    return true;
  }
};

// tx 구조체 유효성 검사
const isTxStructureValid = tx => {
  if (typeof tx.id !== "string") {
    console.log("Tx ID is not valid");
    return false;
  } else if (!(tx.txIns instanceof Array)) {
    console.log("The txIns are not an array");
    return false;
  } else if (
    !tx.txIns.map(isTxInStructureValid).reduce((a, b) => a && b, true)
  ) {
    console.log("The structure of one of the txIn is not valid");
    return false;
  } else if (!(tx.txOuts instanceof Array)) {
    console.log("The txOuts are not an array");
    return false;
  } else if (
    !tx.txOuts.map(isTxOutStructureValid).reduce((a, b) => a && b, true)
  ) {
    console.log("The structure of one of the txOut is not valid");
    return false;
  } else {
    return true;
  }
};

const validateTxIn = (txIn, tx, uTxOuts) => {
  const wantedTxOut = findUTxOut(txIn.txOutId, txIn.txOutIndex, uTxOuts);
  if (wantedTxOut === undefined) {
    console.log(`Didn't find the wanted uTxOut, the tx: ${tx} is invalid`);
    return false;
  } else {
    const address = wantedTxOut.address;
    try {
      const key = ec.keyFromPublic(address, "hex");
      return key.verify(tx.id, txIn.signature) === true;
    } catch (e) {
      console.log(`Couldn't verify the signature of a txIn: ${e.message}`);
      return false;
    }
  }
};

const getAmountInTxIn = (txIn, uTxOuts) => {
  const uTxOut = findUTxOut(txIn.txOutId, txIn.txOutIndex, uTxOuts);
  return uTxOut === undefined ? 0 : uTxOut.amount;
};

const sumTxIns = (tx, uTxOuts) =>
  tx.txIns.map(txIn => getAmountInTxIn(txIn, uTxOuts)).reduce((a, b) => a + b, 0);

const sumTxOuts = tx =>
  tx.txOuts.map(txOut => txOut.amount).reduce((a, b) => a + b, 0);

/*
 * 백서 6장:
 *
 *   "If the output value of a transaction is less than its input value, the
 *    difference is a transaction fee that is added to the incentive value of
 *    the block containing the transaction."
 *
 * 예전에는 입력합과 출력합이 정확히 같아야만 통과시켰다. 그래서 수수료를
 * 낼 방법이 아예 없었고, 채굴자에게는 보조금 말고 아무 유인이 없었다.
 */
const getTxFee = (tx, uTxOuts) => sumTxIns(tx, uTxOuts) - sumTxOuts(tx);

// 블록 단위로 검증할 때는 색인을 한 번만 만들어 돌려 쓴다.
// 낱개로 부를 때는 기본값이 알아서 만든다(기본 인자는 필요할 때만 계산된다).
const validateTx = (tx, uTxOutList, uTxOuts = indexByOutpoint(uTxOutList)) => {
  if (!isTxStructureValid(tx)) {
    console.log("Tx structure is invalid");
    return false;
  }

  if (getTxId(tx) !== tx.id) {
    console.log("Tx ID is not valid");
    return false;
  }

  const hasValidTxIns = tx.txIns
    .map(txIn => validateTxIn(txIn, tx, uTxOuts))
    .every(isValid => isValid === true);

  if (!hasValidTxIns) {
    console.log(`The tx: ${tx} doesn't have valid txIns`);
    return false;
  }

  // 출력이 입력보다 많으면 무에서 돈을 만들어 내는 것이다.
  // 반대로 모자란 만큼은 수수료로 채굴자에게 간다.
  const fee = getTxFee(tx, uTxOuts);
  if (fee < 0) {
    console.log(`The tx: ${tx.id} spends more than its inputs hold`);
    return false;
  }
  return true;
};

const validateCoinbaseTx = (tx, blockIndex, totalFees = 0) => {
  const expected = getBlockSubsidy(blockIndex) + totalFees;
  if (getTxId(tx) !== tx.id) {
    console.log("Invalid Coinbase tx ID");
    return false;
  } else if (tx.txIns.length !== 1) {
    console.log("Coinbase TX should only have one input");
    return false;
  } else if (tx.txIns[0].txOutIndex !== blockIndex) {
    console.log(
      "The txOutIndex of the Coinbase Tx should be the same as the Block Index"
    );
    return false;
  } else if (tx.txOuts.length !== 1) {
    console.log("Coinbase TX should only have one output");
    return false;
  } else if (tx.txOuts[0].amount !== expected) {
    // 보조금을 부풀리거나, 담기지도 않은 수수료를 챙기려는 블록을 막는다
    console.log(
      `Coinbase TX should pay exactly ${expected} (subsidy ${getBlockSubsidy(
        blockIndex
      )} + fees ${totalFees}) but pays ${tx.txOuts[0].amount}`
    );
    return false;
  } else {
    return true;
  }
};

// 코인 기반 트렌젝션 가져오기
const createCoinbaseTx = (address, blockIndex, totalFees = 0) => {
  const tx = new Transaction();
  const txIn = new TxIn();
  txIn.signature = "";
  txIn.txOutId = "";
  txIn.txOutIndex = blockIndex;
  tx.txIns = [txIn];
  tx.txOuts = [new TxOut(address, getBlockSubsidy(blockIndex) + totalFees)];
  tx.id = getTxId(tx);
  return tx;
};

const hasDuplicates = txIns => {
  const groups = _.countBy(txIns, txIn => txIn.txOutId + txIn.txOutIndex);

  return _(groups)
    .map(value => {
      if (value > 1) {
        console.log("Found a duplicated txIn");
        return true;
      } else {
        return false;
      }
    })
    .includes(true);
};

/*
 * 트랜잭션 하나를 색인에 반영한다. 쓴 것은 빼고 만든 것은 넣는다.
 * 블록을 검증하는 동안 뒤 트랜잭션이 앞 트랜잭션의 출력을 볼 수 있게 한다.
 */
const applyTxToIndex = (tx, uTxOuts) => {
  for (const txIn of tx.txIns) {
    uTxOuts.delete(keyOf(txIn.txOutId, txIn.txOutIndex));
  }
  tx.txOuts.forEach((txOut, index) => {
    uTxOuts.set(
      keyOf(tx.id, index),
      new UTxOut(tx.id, index, txOut.address, txOut.amount)
    );
  });
};

/*
 * 블록에 담을 트랜잭션들의 수수료 합.
 *
 * 반드시 담기는 순서대로 훑으며 색인을 갱신해야 한다. 같은 블록 안에서
 * 앞선 트랜잭션이 만든 출력을 뒤 트랜잭션이 쓸 수 있기 때문이다
 * (in-block chaining). 블록 이전의 UTxOut 만 보고 계산하면 그런 입력이
 * "없는 출력"이 되어 수수료가 음수로 나오고, 코인베이스가 보조금보다
 * 적게 가져가는 블록을 만들어 스스로 거부하게 된다.
 *
 * validateBlockTxs 가 검증하면서 세는 방식과 같아야 한다.
 */
const sumBlockFees = (txs, uTxOutList) => {
  const uTxOuts = indexByOutpoint(uTxOutList);
  let total = 0;
  for (const tx of txs) {
    total += getTxFee(tx, uTxOuts);
    applyTxToIndex(tx, uTxOuts);
  }
  return total;
};

const validateBlockTxs = (txs, uTxOutList, blockIndex) => {
  if (!(txs instanceof Array) || txs.length === 0) {
    console.log("A block must contain at least a coinbase tx");
    return false;
  }

  if (txs.length > MAX_TXS_PER_BLOCK) {
    console.log(
      `A block may hold at most ${MAX_TXS_PER_BLOCK} txs, this one has ${txs.length}`
    );
    return false;
  }

  const txIns = _(txs)
    .map(tx => tx.txIns)
    .flatten()
    .value();

  if (hasDuplicates(txIns)) {
    console.log("Found duplicated txIns");
    return false;
  }

  /*
   * 같은 id 를 가진 트랜잭션이 한 블록에 두 번 들어오면, 머클 트리가 홀수
   * 개의 잎을 마지막 것으로 복제해 채우는 성질 때문에 서로 다른 트랜잭션
   * 집합이 같은 머클 루트를 갖게 만들 수 있다(비트코인 CVE-2012-2459).
   * 위의 txIn 중복 검사로도 대부분 걸리지만 명시적으로 막아 둔다.
   */
  if (_.uniqBy(txs, tx => tx.id).length !== txs.length) {
    console.log("Found duplicated tx ids");
    return false;
  }

  /*
   * 일반 트랜잭션을 먼저 검증해야 코인베이스가 가져갈 수수료 합을 알 수 있다.
   *
   * 색인은 트랜잭션을 하나씩 검증하면서 함께 갱신한다. 그래야 같은 블록
   * 안에서 앞선 트랜잭션이 만든 출력을 뒤 트랜잭션이 쓸 수 있다
   * (in-block chaining). 블록 이전의 UTxOut 만 보면 그런 블록을 거부하게 된다.
   *
   * 같은 outpoint 를 두 번 쓰는 것은 위의 hasDuplicates 가 이미 막는다.
   */
  const nonCoinbaseTxs = txs.slice(1);
  const uTxOuts = indexByOutpoint(uTxOutList);
  let totalFees = 0;
  for (const tx of nonCoinbaseTxs) {
    if (!validateTx(tx, uTxOutList, uTxOuts)) {
      console.log(`The tx ${tx.id} in this block is invalid`);
      return false;
    }
    // 수수료는 입력을 걷어 내기 전에 구해야 한다
    totalFees += getTxFee(tx, uTxOuts);
    applyTxToIndex(tx, uTxOuts);
  }

  if (!validateCoinbaseTx(txs[0], blockIndex, totalFees)) {
    console.log("Coinbase Tx is invalid");
    return false;
  }

  return true;
};

// Tx 프로세스
const processTxs = (txs, uTxOutList, blockIndex) => {
  if (!validateBlockTxs(txs, uTxOutList, blockIndex)) {
    return null;
  }
  return updateUTxOuts(txs, uTxOutList);
};

/*
 * reorg(체인 교체) 되감기용 데이터.
 *
 * 지금까지 체인이 갈라지면 후보 체인을 제네시스부터 전부 재생해서 UTxOut
 * 집합을 다시 만들었다. 서명 검증은 공통 접두사만큼 건너뛰게 해 뒀지만,
 * 재생 자체는 여전히 체인 길이에 비례한다. 실제로 갈라지는 것은 보통
 * 마지막 한두 블록인데 만 블록을 다시 훑는 셈이다.
 *
 * 블록 하나가 UTxOut 집합에 한 일은 두 가지뿐이다.
 *
 *   - 자기 출력들을 넣는다
 *   - 입력이 가리키는 이전 출력들을 걷어 낸다
 *
 * 걷어 낸 것들만 블록마다 적어 두면(undo 데이터), 되감기는 그 반대로 하면
 * 된다. 그러면 reorg 비용이 체인 길이가 아니라 갈라진 깊이에 비례한다.
 * 2000블록 체인에서 한 블록 갈라진 경우 218ms -> 0.2ms 로 줄었다.
 *
 * 주의: 같은 블록 안에서 만들어지고 바로 쓰인 출력은 적지 않는다.
 * uTxOutList 는 블록을 적용하기 *전*의 집합이므로 그런 출력은 애초에
 * 여기에 없다. 되감을 때도 되살아나면 안 되는 것들이라 이게 맞다.
 */
const collectConsumed = (txs, uTxOutList) => {
  const spent = new Set();
  for (const tx of txs) {
    for (const txIn of tx.txIns) {
      spent.add(keyOf(txIn.txOutId, txIn.txOutIndex));
    }
  }
  return uTxOutList.filter(uTxOut => spent.has(outpointKey(uTxOut)));
};

/*
 * 블록 하나를 UTxOut 집합에서 되감는다. collectConsumed 의 짝이다.
 *
 *   updateUTxOuts(txs, before) === after
 *   rollbackTxs(txs, after, collectConsumed(txs, before)) === before (순서 무관)
 */
const rollbackTxs = (txs, uTxOutList, consumed) => {
  const created = new Set();
  for (const tx of txs) {
    for (let index = 0; index < tx.txOuts.length; index++) {
      created.add(keyOf(tx.id, index));
    }
  }
  return uTxOutList
    .filter(uTxOut => !created.has(outpointKey(uTxOut)))
    .concat(consumed);
};

module.exports = {
  updateUTxOuts,
  collectConsumed,
  rollbackTxs,
  getPublicKey,
  isAddressValid,
  getBlockSubsidy,
  getTotalSupply,
  getTxFee,
  sumBlockFees,
  HALVING_INTERVAL,
  INITIAL_SUBSIDY,
  MAX_TXS_PER_BLOCK,
  getTxId,
  signTxIn,
  TxIn,
  Transaction,
  TxOut,
  createCoinbaseTx,
  processTxs,
  validateTx
};
