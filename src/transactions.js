const CryptoJS = require("crypto-js"),
  elliptic = require('elliptic'),
  _ = require("lodash"),
  utils = require("./utils");

const ec = new elliptic.ec("secp256k1");

const COINBASE_AMOUNT = 10;

class TxOut {
  constructor(address, amount){
    this.address = address;
    this.amount = amount;
  }
};

class TxIn {
  // TxOutId
  // TxOutIndex
  // Signature
};

class Transaction {
  // id
  // txIns[]
  // txOuts[]
};

class UTxOut {
  constructor(txOutId, txOutIndex, address, amount){
    this.txOutId = txOutId;
    this.txOutIndex = txOutIndex;
    this.address = address;
    this.amount = amount;
  }
};

const uTxOuts = [];

const getTxId = tx => {
  const txInContent = tx.txIns.map(txIn => txIn.uTxOutId + txIn.uTxOutIndex).reduce((a, b) => a + b, "");

  const txOutContent = tx.txOuts.map(txOut => txOut.address + txOut.amount).reduce((a, b) => a + b, "");
  return CryptoJS.SHA256(txInContent + txOutContent).toString();
};

const findUTxOut = (txOutId, txOutIndex, uTxOutList) => {
  return uTxOutList.find(uTxO => uTxO.txOutId === txOutId && uTxO.txOutIndex === txOutIndex);
};

const signTxIn = (tx, txInIndex, privateKey, uTxOutList) => {
  const txIn = tx.txIns[txInIndex];
  const dataToSign = tx.id;
  // find Tx
  const referencedUTxOut = findUTxOut(
    txIn.txOutId,
    txIn.txOutIndex,
    uTxOutList
  );
  if(referencedUTxOut === null || referencedUTxOut === undefined){
    throw Error("Couldn't not find the referenced uTxOut, not signing");
    return;
  }
  // 주소 검증하기
  const referencedAddress = referencedUTxOut.address;
  if(getPublicKey(privateKey) !== referencedAddress){
    return false;
  }
  const key = ec.keyFromPrivate(privateKey, "hex");
  const signature = utils.toHexString(key.sign(dataToSign).toDER());
  return signature;
};

//공개키 얻어오기
const getPublicKey = (privateKey) => {
  return ec.keyFromPrivate(privateKey, "hex").getPublic().encode("hex");
}

const updateUTxOuts = (newTxs, uTxOutList) => {
  const newUTxOuts = newTxs.map(tx => tx.txOuts.map(
        (txOut, index) => new UTxOut(tx.id, index, txOut.address, txOut.amount)
      )
  ).reduce((a, b) => a.concat(b), []);

  const spentTxOuts = newTxs.map(tx => tx.txIns).reduce((a, b) => a.concat(b), []).map(txIn => new UTxOut(txIn.txOutId, txIn.txOutIndex, "", 0));

  const resultingUTxOuts = uTxOutList.filter(uTxO => !findUTxOut(uTxO.txOutId, uTxO.txOutIndex, spentTxOuts)).concat(newUTxOuts);

  return resultingUTxOuts;
};

const isTxInStructureValid = txIn => {
  if(txIn === null){
    return false;
  }else if(typeof txIn.signature !== "string"){
    return false;
  }else if(typeof txIn.txOutId !== "string"){
    return false;
  }else if(typeof txIn.txOutIndex !== "number"){
    return false;
  }else {
    return true;
  }
}

const isAddressValid = address => {
  if(address.length !== 130){
    return false;
  }else if(address.match("^[a-fA-F0-9]+$") === null)  {
    return false;
  }else if(!address.startsWith("04")){
    return false;
  }else{
    return true;
  }
}

const isTxOutStructureValid = txOut => {
  if(txOut === null){
    return false;
  }else if (typeof txOut.address !== "string") {
    return false;
  }else if (!isAddressValid(txOut.address)) {
    return false;
  }else if(typeof txOut.amount !== "number") {
    return false;
  }else {
    return true;
  }
}


// 구조체 검증
const isTxStructureValid = tx => {
  if(typeof tx.id !== "string"){
    console.log("Tx id is not valid");
    return false;
  }else if(!(tx.txIns instanceof Array)){
    console.log("the txIns are not and array");
    return false;
  }else if(!tx.txIns.map(isTxInStructureValid).reduce((a, b) => a && b, true)){
    console.log("the structure of one of the txIn is not valid");
    return false;
  }else if(!(tx.txOuts instanceof Array)){
    console.log("the txOuts are not an array");
    return false;
  }else if(!tx.txOut.map(isTxOutStructureValid).reduce((a,b) => a && b, true)){
    console.log("the sturcture of one of the txOut is not valid");
    return false;
  }else {
    return true;
  }
}

// TX 인풋
const validateTxIn = (txIn, tx, uTxOutList) => {
  const wantedTxOut = uTxOutList.find(uTxO => uTxO.txOutId === txIn.txOutId && uTxO.txOutIndex === txIn.txOutIndex);
  if(wantedTxOut === null){
    return false;
  }else{
    const address = wantedTxOut.address;
    const key = ec.keyFromPublic(address, "hex");
    return key.verify(tx.id, txIn.signature);
  }
}


// TX Amount Input
const getAmountInTxIn = (txIn, uTxOutList) => findUTxOut(txIn.txOutId, txIn.txOutIndex, uTxOutList).amount;


// TX 검증
const validateTx = (tx, uTxOutList) => {
    if(!isTxStructureValid(tx)){
      return false;
    }

    if(getTxId(tx) !== tx.id) {
      return false;
    }

    const hasValidTxIns = tx.txIns.map(txIn => validateTxIn(txIn, tx, uTxOutList));

    if(!hasValidTxIns) {
      return;
    }

    const amountInTxIns = tx.txIns.map(txIn => getAmountInTxIn(txIn, uTxOutList)).reduce((a, b) => a + b ,0);

    const amountInTxOuts = tx.txOuts.map(txOut => txOut.amount).reduce((a,b) => a + b , 0);

    if(amountInTxIns !== amountInTxOuts){
      return false;
    }else{
      return true;
    }
}

const validateCoinbaseTx = (tx, blockIndex) => {
  if(getTxId(tx) !== tx.id){
    return false;
  }else if(tx.txIns.length !== 1){
    return false;
  }else if(tx.txIns[0].txOutIndex !== blockIndex){
    return false;
  }else if(tx.txOuts.length !== 1){
    return false;
  }else if(tx.txOuts[0].amount !== COINBASE_AMOUNT){
    return false;
  }else {
    return true;
  }
}

const createCoinbaseTx = (address, blockIndex) => {
  const tx = new Transaction();
  const txIn = new TxIn();
  txIn.signature  = "";
  txIn.txOutId = "";
  txIn.txOutIndex = blockIndex;
  tx.txIns = [txIn];
  tx.txOuts = [new TxOut(address, COINBASE_AMOUNT)];
  tx.id = getTxId(tx);
  return tx;
};

const hasDuplicates = txIns => {
  const groups = _.countBy(txIns, txIn => txIn.txOutId + txIn.txOutIndex);

  return _(groups).map(value => {
      if(value > 1){
        console.log("Found a duplicated txIn");
        return true;
      }else{
        return false;
      }
    })
    .includes(true);
};

const validateBlockTxs = (txs, uTxOutList, blockIndex) => {
  const coinbaseTx = txs[0];
  if(!validateCoinbaseTx(coinbaseTx, blockIndex)){
    console.log("Coinbase Tx is invalid");
  }

  const txIns = _(txs).map(tx => tx.txIns).flatten().value();

  if(hasDuplicates(txIns)){
    console.log("Found duplicated txIns");
    return false;
  }

  const nonCoinbaseTxs = txs.slice(1);

  return nonCoinbaseTxs.map(tx => validateTx(tx, uTxOutList)).reduce((a, b) => a + b, true);
}

const processTxs = (txs, uTxOutList, blockIndex) => {
  if(!validateBlockTxs(txs, uTxOutList, blockIndex)){
    return null;
  }
  return updateUTxOuts(txs, uTxOutList);
}

module.exports = {
  getPublicKey,
  getTxId,
  signTxIn,
  TxIn,
  Transaction,
  TxOut,
  createCoinbaseTx,
  processTxs,
  validateTx
}
