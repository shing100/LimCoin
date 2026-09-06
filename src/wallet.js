/**
 * 계층 결정적(HD) 지갑.
 *
 * 백서 10장 "Privacy":
 *
 *   "As an additional firewall, a new key pair should be used for each
 *    transaction to keep them from being linked to a common owner."
 *
 * 예전 지갑은 개인키 하나를 만들어 영원히 재사용했다. 그 주소에 얽힌 모든
 * 거래가 한 사람의 것으로 묶여 버린다.
 *
 * 이제 씨앗 하나에서 필요한 만큼 키를 파생한다(BIP32). 백업할 것은 여전히
 * 하나지만 주소는 얼마든지 쓸 수 있다. 거스름돈은 항상 새 주소로 받으므로,
 * 보낸 금액과 남은 금액이 같은 주소로 묶이지 않는다.
 */
const path = require("path"),
  fs = require("fs"),
  Transactions = require("./transactions"),
  HD = require("./hdwallet");

const { keyOf, outpointKey } = require("./utxo");

const {
  getPublicKey,
  getTxId,
  signTxIn,
  TxIn,
  Transaction,
  TxOut
} = Transactions;

const WALLET_VERSION = 1;

const walletLocation = () => path.join(__dirname, "wallet.json");
// 예전 지갑이 쓰던 파일. 있으면 그 키를 가져온다.
const legacyKeyLocation = () => path.join(__dirname, "privateKey");

let cache = null;

const readWallet = () => {
  if (cache !== null) {
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(walletLocation(), "utf8"));
  return cache;
};

const writeWallet = wallet => {
  cache = wallet;
  fs.writeFileSync(walletLocation(), JSON.stringify(wallet, null, 2) + "\n");
};

/**
 * 지갑 파일을 만든다. 이미 있으면 아무것도 하지 않는다.
 *
 * 예전 형식(개인키 하나짜리 privateKey 파일)이 남아 있으면 그 키를
 * imported 로 옮긴다. 그러지 않으면 그 주소로 받아 둔 코인을 쓸 수 없게 된다.
 */
const initWallet = () => {
  if (fs.existsSync(walletLocation())) {
    return;
  }

  const imported = [];
  if (fs.existsSync(legacyKeyLocation())) {
    const legacy = fs.readFileSync(legacyKeyLocation(), "utf8").trim();
    if (legacy) {
      imported.push(legacy);
      console.log(
        "예전 형식의 개인키를 발견해 지갑으로 가져왔습니다. 그 주소의 잔액은 그대로 쓸 수 있습니다."
      );
    }
  }

  writeWallet({
    version: WALLET_VERSION,
    seed: HD.generateSeed(),
    // 받는 주소는 바로 쓸 수 있게 하나 미리 만들어 둔다.
    // 거스름돈 주소는 실제로 송금할 때 만든다.
    nextReceive: 1,
    nextChange: 0,
    imported
  });
};

const getSeed = () => readWallet().seed;

const deriveAt = (wallet, branch, index) =>
  HD.derivePrivateKey(wallet.seed, branch, index);

/**
 * 지갑이 가진 모든 키. 받는 주소 + 거스름돈 주소 + 예전 형식에서 가져온 것.
 */
const getAllKeys = () => {
  const wallet = readWallet();
  const keys = [];

  const push = (branch, index, kind) => {
    const privateKey = deriveAt(wallet, branch, index);
    keys.push({ kind, index, privateKey, address: getPublicKey(privateKey) });
  };

  for (let i = 0; i < wallet.nextReceive; i++) {
    push(HD.RECEIVE, i, "receive");
  }
  for (let i = 0; i < wallet.nextChange; i++) {
    push(HD.CHANGE, i, "change");
  }
  for (const privateKey of wallet.imported) {
    keys.push({
      kind: "imported",
      index: null,
      privateKey,
      address: getPublicKey(privateKey)
    });
  }
  return keys;
};

const getAddresses = () => getAllKeys().map(key => key.address);

// 지금 받는 데 쓰는 주소 (가장 최근에 만든 받는 주소)
const getReceiveAddress = () => {
  const wallet = readWallet();
  return getPublicKey(deriveAt(wallet, HD.RECEIVE, wallet.nextReceive - 1));
};

// 받는 주소를 하나 더 만든다
const getNewAddress = () => {
  const wallet = readWallet();
  const address = getPublicKey(deriveAt(wallet, HD.RECEIVE, wallet.nextReceive));
  writeWallet({ ...wallet, nextReceive: wallet.nextReceive + 1 });
  return address;
};

/*
 * 거스름돈 주소는 따로 만든다. 이걸 받는 주소와 섞으면 남에게 알려 준
 * 주소로 거스름돈이 돌아와, 주소를 새로 만드는 의미가 없어진다.
 */
const getChangeAddress = () => {
  const wallet = readWallet();
  const address = getPublicKey(deriveAt(wallet, HD.CHANGE, wallet.nextChange));
  writeWallet({ ...wallet, nextChange: wallet.nextChange + 1 });
  return address;
};

// 예전 API 이름. 코인베이스 수취 주소로 쓰인다.
const getPublicFromWallet = () => getReceiveAddress();

// 임의의 주소 잔액. 공개 API 가 쓴다.
const getBalance = (address, uTxOuts) =>
  uTxOuts
    .filter(uTxOut => uTxOut.address === address)
    .reduce((sum, uTxOut) => sum + uTxOut.amount, 0);

// 이 지갑이 가진 모든 주소의 잔액 합
const getWalletBalance = uTxOuts => {
  const mine = new Set(getAddresses());
  return uTxOuts
    .filter(uTxOut => mine.has(uTxOut.address))
    .reduce((sum, uTxOut) => sum + uTxOut.amount, 0);
};

const findAmountInUTxOuts = (amountNeeded, myUTxOuts) => {
  let currentAmount = 0;
  const includedUTxOuts = [];
  for (const myUTxOut of myUTxOuts) {
    includedUTxOuts.push(myUTxOut);
    currentAmount = currentAmount + myUTxOut.amount;
    if (currentAmount >= amountNeeded) {
      return { includedUTxOuts, leftOverAmount: currentAmount - amountNeeded };
    }
  }
  throw Error("Not enough funds");
};

// mempool 에서 이미 쓰기로 예약된 UTxOut 은 빼고 고른다.
const filterUTxOutsFromMempool = (uTxOutList, mempool) => {
  const pending = new Set();
  for (const tx of mempool) {
    for (const txIn of tx.txIns) {
      pending.add(keyOf(txIn.txOutId, txIn.txOutIndex));
    }
  }
  return uTxOutList.filter(uTxOut => !pending.has(outpointKey(uTxOut)));
};

const createTxOuts = (receiverAddress, changeAddress, amount, leftOverAmount) => {
  const receiverTxOut = new TxOut(receiverAddress, amount);
  if (leftOverAmount === 0) {
    return [receiverTxOut];
  }
  return [receiverTxOut, new TxOut(changeAddress, leftOverAmount)];
};

/**
 * 송금 트랜잭션을 만든다.
 *
 * 수수료는 따로 출력을 만들지 않는다. "입력합 - 출력합" 의 차액이 곧
 * 수수료이므로 거스름돈에서 그만큼 덜 돌려받으면 된다.
 *
 * 입력은 지갑이 가진 모든 주소에서 고르고, 각 입력은 그 주소에 맞는 키로
 * 서명한다. 거스름돈은 새 주소로 받는다 — 이게 백서 10장이 말하는
 * "트랜잭션마다 새 키"다.
 */
const createTx = (receiverAddress, amount, uTxOutList, memPool, fee = 0) => {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw Error("보내는 금액은 최소 단위 기준 양의 정수여야 합니다");
  }
  if (!Number.isInteger(fee) || fee < 0) {
    throw Error("수수료는 최소 단위 기준 0 이상의 정수여야 합니다");
  }

  const keyByAddress = new Map(getAllKeys().map(key => [key.address, key.privateKey]));
  const myUTxOuts = uTxOutList.filter(uTxOut => keyByAddress.has(uTxOut.address));
  const available = filterUTxOutsFromMempool(myUTxOuts, memPool);

  const { includedUTxOuts, leftOverAmount } = findAmountInUTxOuts(amount + fee, available);

  const tx = new Transaction();
  tx.txIns = includedUTxOuts.map(uTxOut => {
    const txIn = new TxIn();
    txIn.txOutId = uTxOut.txOutId;
    txIn.txOutIndex = uTxOut.txOutIndex;
    return txIn;
  });

  // 거스름돈이 있을 때만 새 주소를 쓴다. 자리를 먼저 확보하고 만든다.
  const changeAddress = leftOverAmount > 0 ? getChangeAddress() : null;
  tx.txOuts = createTxOuts(receiverAddress, changeAddress, amount, leftOverAmount);

  tx.id = getTxId(tx);

  // 입력마다 그 입력이 가리키는 주소의 키로 서명한다
  tx.txIns = tx.txIns.map((txIn, index) => {
    const source = includedUTxOuts[index];
    txIn.signature = signTxIn(tx, index, keyByAddress.get(source.address), uTxOutList);
    return txIn;
  });

  return tx;
};

module.exports = {
  initWallet,
  getSeed,
  getAllKeys,
  getAddresses,
  getReceiveAddress,
  getNewAddress,
  getChangeAddress,
  getPublicFromWallet,
  getBalance,
  getWalletBalance,
  createTx
};
