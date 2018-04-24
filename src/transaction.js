const CryptoJS = require("crypto-js"),
  elliptic = require('elliptic'),
  utils = require("./utils");

const ec = new elliptic.ec("secp256k1");

class TxOut {
  constructor(address, amount){
    this.address = address;
    this.amount = amount;
  }
};

class TxIn {
  // uTxOutId
  // uTxOutIndex
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
  const txInContent = tx.txIns
    .map(txIn => txIn.uTxOutId + txIn.uTxOutIndex)
    .reduce((a, b) => a + b, "");

  const txOutContent = tx.txOuts
    .map(txOut => txOut.address + txOut.amount)
    .reduce((a, b) => a + b, "");
  return CryptoJS.SHA256(txInContent + txOutContent).toString();
};

const findUTxOut = (txOutId, txOutIndex, uTxOutList) => {
  return uTxOutList.find(uTxOut => uTxOut.txOutId === uTxOutId && uTxOut.txOutIndex === txOutIndex);
};

const signTxIn = (tx, txInIndex, privateKey, uTxOut) => {
  const txIn = tx.txIns[txInIndex];
  const dataToSign = tx.id;
  // find Tx
  const referencedUTxOut = findUTxOut(txIn.txOutId, tx.txOutIndex, uTxOuts);
  if(referencedUTxOut === null){
    return;
  }
  const key = ec.keyFromPrivate(privateKey, "hex");
  const signature = tuils.toHexString(key.sign(dataToSign).toDER());
  return signature;
};
