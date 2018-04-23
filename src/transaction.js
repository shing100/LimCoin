class TxOut {
  constructor(address, amount){
    this.address = address;
    this.amount = amount;
  }
}

class TxIn {
  // uTxOutID
  // uTxOutIndex
  // Signature
}

class Transaction {
  // id
  // txIns[]
  // txOuts[]
}

class UTxOut {
  constructor(uTxOutId, uTxOutIndex, address, amount){
    this.uTxOutId = uTxOutId;
    this. uTxOutIndex = uTxOutIndex;
    this.address = address;
    this.amount = amount;
  }
}


const uTxOuts = [];
