const Keys = require("./keys");
const Address = require("./address");
const Params = require("./params");
const Script = require("./script");
const { txIdOf, txSizeOf } = require("./serialization");
const { COIN } = require("./units");
const { keyOf, outpointKey, indexByOutpoint } = require("./utxo");

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

/*
 * 코인베이스 성숙도.
 *
 * 갓 만들어진 코인베이스 출력은 바로 쓸 수 없다. 체인이 갈라져 그 블록이
 * 밀려나면 코인베이스는 통째로 사라지고, 그것을 쓴 트랜잭션도 전부 무효가
 * 된다 — 그 코인을 받은 사람은 영문도 모르고 잃는다. 일반 트랜잭션은
 * 밀려나도 mempool 로 되돌아가 다시 담기지만 코인베이스는 그럴 수 없다.
 *
 * 비트코인은 100블록(약 16시간)을 기다리게 한다. 재구성은 보통 1~2블록
 * 깊이이므로 그만큼이면 사실상 확정이라는 것이다.
 *
 * 여기서는 10으로 둔다. 블록 주기가 10초라 100이면 실습에서 17분을
 * 기다려야 하고, 재구성 깊이에 견주면 10도 충분히 깊다. 난이도 조정
 * 주기와 같은 값이라 기억하기도 좋다.
 */
const COINBASE_MATURITY = 10;

/*
 * 블록 한도.
 *
 * 예전에는 "트랜잭션 100건"이 유일한 한도였다. 크기를 재지 않으니 출력이
 * 백 개인 트랜잭션도 한 건, 두 개인 것도 한 건이라 같은 값을 냈다. 진짜
 * 비용은 바이트다 — 망으로 오가고 디스크에 남고 검증해야 하는 양.
 *
 * 100KB / 10초 = 10KB/s. 비트코인(1MB / 600초 ≈ 1.7KB/s)의 여섯 배쯤이다.
 * 건수 상한은 그대로 두되(검증 횟수의 안전판) 넉넉하게 올린다.
 */
const MAX_BLOCK_BYTES = 100000;
const MAX_TXS_PER_BLOCK = 2000;

// 트랜잭션이 블록에서 차지하는 바이트 (해제 데이터 포함)
const getTxSize = tx => txSizeOf(tx);

// 릴레이 최소 수수료율(lm/byte). 이보다 낮으면 mempool 이 받지 않는다.
// 입력 하나짜리 보통 트랜잭션(약 270바이트)이면 1080 lm 쯤 — 예전의
// "입력당 1000 lm" 과 비슷한 값이다.
const MIN_RELAY_FEE_RATE = 4;

// 이 트랜잭션의 수수료율 (lm/byte)
const getTxFeeRate = (tx, uTxOuts) => getTxFee(tx, uTxOuts) / getTxSize(tx);

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

/*
 * blockIndex 는 이 출력이 만들어진 블록의 높이다. mempool 이 만든 출력은
 * 아직 블록이 없으므로 null 이다. coinbase 는 성숙도 검사에 쓴다 —
 * 그 둘이 없으면 "얼마나 깊이 묻혔는지"를 알 수 없다.
 */
class UTxOut {
  constructor(txOutId, txOutIndex, address, amount, blockIndex = null, coinbase = false) {
    this.txOutId = txOutId;
    this.txOutIndex = txOutIndex;
    this.address = address;
    this.amount = amount;
    this.blockIndex = blockIndex;
    this.coinbase = coinbase;
  }
}

// 코인베이스는 이전 출력을 가리키지 않는 유일한 트랜잭션이다
const isCoinbaseTx = tx =>
  tx.txIns.length === 1 && tx.txIns[0].txOutId === "";

/*
 * 코인베이스 출력이 spendHeight 높이에서 쓸 수 있을 만큼 묻혔는가.
 * 높이를 모르면 쓸 수 없는 것으로 본다 — 모른 채 통과시키느니 막는다.
 */
const isSpendable = (uTxOut, spendHeight) => {
  if (uTxOut.coinbase !== true) {
    return true;
  }
  if (!Number.isInteger(spendHeight) || !Number.isInteger(uTxOut.blockIndex)) {
    return false;
  }
  return spendHeight - uTxOut.blockIndex >= COINBASE_MATURITY;
};

// tx id 가져오기
/*
 * txid = sha256d(정규 직렬화). 서명과 공개키는 들어가지 않는다 —
 * "무엇을 어디로 보내는가"만 덮으므로 서명 바이트가 바뀌어도 id 는 같다.
 * 바이트 형식은 serialization.js 에 있다.
 */
const getTxId = tx => txIdOf(tx);

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
  const publicKey = getPublicKey(privateKey);
  if (!Address.addressMatchesPublicKey(referencedUTxOut.address, publicKey, addressVersion())) {
    return false;
  }
  // 주소가 공개키의 해시라 검증하는 쪽이 공개키를 알 길이 없다. 입력에 실어 준다.
  txIn.publicKey = publicKey;
  return Keys.sign(privateKey, dataToSign);
};

// 공개키 얻어오기
const getPublicKey = privateKey => Keys.getPublicKey(privateKey);

// 이 노드가 속한 망의 주소 버전 바이트
const addressVersion = () => Params.current().addressVersion;
// 스크립트 주소(P2SH) 버전 바이트
const scriptAddressVersion = () => Params.current().scriptAddressVersion;

const updateUTxOuts = (newTxs, uTxOutList, blockIndex = null) => {
  const newUTxOuts = newTxs
    .map(tx =>
      tx.txOuts.map(
        (txOut, index) =>
          new UTxOut(
            tx.id,
            index,
            txOut.address,
            txOut.amount,
            blockIndex,
            isCoinbaseTx(tx)
          )
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
  } else if (txIn.publicKey !== undefined && typeof txIn.publicKey !== "string") {
    console.log("The txIn's publicKey is not a string");
    return false;
  } else if (txIn.redeemScript !== undefined && typeof txIn.redeemScript !== "string") {
    console.log("The txIn's redeemScript is not a string");
    return false;
  } else if (
    txIn.unlock !== undefined &&
    (!Array.isArray(txIn.unlock) || txIn.unlock.some(item => typeof item !== "string"))
  ) {
    console.log("The txIn's unlock is not an array of hex strings");
    return false;
  } else {
    return true;
  }
};

// 주소 유효성 검사
/*
 * 이 망에서 받을 수 있는 주소인가.
 *
 * Base58Check 주소(체크섬과 망 버전 바이트가 맞아야 한다) 또는 예전 형식
 * (비압축 공개키 hex 130자). 다른 망의 주소는 여기서 걸린다 — 테스트넷
 * 주소로 메인넷 코인을 보낼 수 없다.
 */
const isAddressValid = address => {
  if (!Address.isAddressValid(address, addressVersion(), scriptAddressVersion())) {
    console.log("The address is not valid for this network");
    return false;
  }
  return true;
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
  } else if (
    tx.lockTime !== undefined &&
    (!Number.isInteger(tx.lockTime) || tx.lockTime < 0 || tx.lockTime > 0xffffffff)
  ) {
    console.log("The tx lockTime is not a uint32");
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

const validateTxIn = (txIn, tx, uTxOuts, spendHeight, mtp) => {
  const wantedTxOut = findUTxOut(txIn.txOutId, txIn.txOutIndex, uTxOuts);
  if (wantedTxOut === undefined) {
    console.log(`Didn't find the wanted uTxOut, the tx: ${tx} is invalid`);
    return false;
  } else if (!isSpendable(wantedTxOut, spendHeight)) {
    console.log(
      `코인베이스 출력은 ${COINBASE_MATURITY}블록이 쌓여야 쓸 수 있습니다 ` +
        `(만들어진 높이 ${wantedTxOut.blockIndex}, 쓰려는 높이 ${spendHeight})`
    );
    return false;
  } else {
    /*
     * 누구의 서명이어야 하는가.
     *
     * 예전 형식 주소는 그 자체가 공개키다. 새 주소는 공개키의 해시이므로
     * 입력에 실린 공개키가 그 주소의 것인지 먼저 보고, 그 공개키로 서명을
     * 확인한다. 둘 중 하나라도 어긋나면 남의 코인이다.
     */
    const address = wantedTxOut.address;

    /*
     * 스크립트 주소(P2SH)면 조건이 주소에 해시로만 들어 있다. 원본
     * (redeemScript)을 입력에 실어 보내야 하고, 그 해시가 주소와 맞아야
     * 하며, unlock 데이터로 그 스크립트를 통과시켜야 한다.
     */
    if (Address.scriptHashOf(address, scriptAddressVersion()) !== null) {
      if (!Address.scriptMatchesAddress(address, txIn.redeemScript, scriptAddressVersion())) {
        console.log("The txIn's redeemScript does not match the referenced script address");
        return false;
      }
      const passed = Script.run(txIn.unlock || [], txIn.redeemScript, {
        txId: tx.id,
        lockTime: tx.lockTime || 0,
        spendHeight,
        medianTimePast: mtp
      });
      if (!passed) {
        console.log("The txIn's unlock data does not satisfy the redeemScript");
        return false;
      }
      return true;
    }

    const publicKey = Address.isLegacyAddress(address) ? address : txIn.publicKey;
    if (!Address.addressMatchesPublicKey(address, publicKey, addressVersion())) {
      console.log("The txIn's public key does not belong to the referenced address");
      return false;
    }
    if (!Keys.verify(publicKey, tx.id, txIn.signature)) {
      console.log("The txIn's signature is invalid");
      return false;
    }
    return true;
  }
};

/*
 * lockTime — "이 높이(또는 시각)가 되어야 블록에 담길 수 있다".
 *
 * 0 이면 제한이 없다. LOCKTIME_THRESHOLD(5억) 미만이면 블록 높이로,
 * 그 이상이면 유닉스 시각으로 읽는다. 시각은 내 시계가 아니라 직전 11블록의
 * 중앙값(MTP)과 견준다 — 채굴자가 시계를 앞당겨 남의 타임락을 일찍 열지
 * 못하게 하려는 것이다.
 *
 * 비트코인은 "lockTime < 높이" 일 때 담을 수 있다(sequence 로 끄는 길도 있다).
 * 여기에는 sequence 가 없고, "lockTime <= 높이" 로 둔다 — lockTime 100 이면
 * 100번 블록부터. 읽는 대로 동작하는 쪽을 골랐다.
 */
const isFinalTx = (tx, spendHeight, mtp) => {
  const lockTime = tx.lockTime || 0;
  if (lockTime === 0) {
    return true;
  }
  if (lockTime < Script.LOCKTIME_THRESHOLD) {
    return typeof spendHeight === "number" && lockTime <= spendHeight;
  }
  return typeof mtp === "number" && lockTime <= mtp;
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
const validateTx = (tx, uTxOutList, uTxOuts = indexByOutpoint(uTxOutList), spendHeight, mtp) => {
  if (!isTxStructureValid(tx)) {
    console.log("Tx structure is invalid");
    return false;
  }

  if (getTxId(tx) !== tx.id) {
    console.log("Tx ID is not valid");
    return false;
  }

  if (!isFinalTx(tx, spendHeight, mtp)) {
    console.log(
      `The tx ${tx.id} is time-locked until ${tx.lockTime} ` +
        `(height ${spendHeight}, median time ${mtp})`
    );
    return false;
  }

  const hasValidTxIns = tx.txIns
    .map(txIn => validateTxIn(txIn, tx, uTxOuts, spendHeight, mtp))
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
  } else if (tx.lockTime) {
    console.log("Coinbase TX must not be time-locked");
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
  const seen = new Set();

  for (const txIn of txIns) {
    const key = txIn.txOutId + txIn.txOutIndex;
    if (seen.has(key)) {
      console.log("Found a duplicated txIn");
      return true;
    }
    seen.add(key);
  }

  return false;
};

/*
 * 트랜잭션 하나를 색인에 반영한다. 쓴 것은 빼고 만든 것은 넣는다.
 * 블록을 검증하는 동안 뒤 트랜잭션이 앞 트랜잭션의 출력을 볼 수 있게 한다.
 */
const applyTxToIndex = (tx, uTxOuts, blockIndex = null) => {
  for (const txIn of tx.txIns) {
    uTxOuts.delete(keyOf(txIn.txOutId, txIn.txOutIndex));
  }
  tx.txOuts.forEach((txOut, index) => {
    uTxOuts.set(
      keyOf(tx.id, index),
      new UTxOut(tx.id, index, txOut.address, txOut.amount, blockIndex, isCoinbaseTx(tx))
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

const validateBlockTxs = (txs, uTxOutList, blockIndex, mtp) => {
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

  const blockBytes = txs.reduce((sum, tx) => sum + getTxSize(tx), 0);
  if (blockBytes > MAX_BLOCK_BYTES) {
    console.log(`A block may hold at most ${MAX_BLOCK_BYTES} bytes, this one has ${blockBytes}`);
    return false;
  }

  const txIns = txs.flatMap(tx => tx.txIns);

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
  if (new Set(txs.map(tx => tx.id)).size !== txs.length) {
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
    if (!validateTx(tx, uTxOutList, uTxOuts, blockIndex, mtp)) {
      console.log(`The tx ${tx.id} in this block is invalid`);
      return false;
    }
    // 수수료는 입력을 걷어 내기 전에 구해야 한다
    totalFees += getTxFee(tx, uTxOuts);
    applyTxToIndex(tx, uTxOuts, blockIndex);
  }

  if (!validateCoinbaseTx(txs[0], blockIndex, totalFees)) {
    console.log("Coinbase Tx is invalid");
    return false;
  }

  return true;
};

// Tx 프로세스
const processTxs = (txs, uTxOutList, blockIndex, mtp) => {
  if (!validateBlockTxs(txs, uTxOutList, blockIndex, mtp)) {
    return null;
  }
  return updateUTxOuts(txs, uTxOutList, blockIndex);
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
  addressVersion,
  isAddressValid,
  getBlockSubsidy,
  getTotalSupply,
  getTxFee,
  getTxFeeRate,
  getTxSize,
  sumBlockFees,
  MAX_BLOCK_BYTES,
  MIN_RELAY_FEE_RATE,
  HALVING_INTERVAL,
  INITIAL_SUBSIDY,
  MAX_TXS_PER_BLOCK,
  COINBASE_MATURITY,
  isCoinbaseTx,
  isSpendable,
  isFinalTx,
  scriptAddressVersion,
  getTxId,
  signTxIn,
  TxIn,
  Transaction,
  TxOut,
  createCoinbaseTx,
  processTxs,
  validateTx
};
