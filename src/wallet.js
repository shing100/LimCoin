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
  HD = require("./hdwallet"),
  BIP39 = require("./bip39");

const { keyOf, outpointKey } = require("./utxo");

const Address = require("./address");

const {
  getPublicKey,
  addressVersion,
  getTxId,
  signTxIn,
  TxIn,
  Transaction,
  TxOut
} = Transactions;

const WALLET_VERSION = 2;

/*
 * 니모닉으로 지갑을 되살릴 때 "어디까지 썼는지"는 저장돼 있지 않다.
 * 체인을 보고 찾아야 하는데, 중간에 안 쓴 주소가 몇 개 있을 수 있으므로
 * 연속으로 이만큼 비어 있으면 거기서 멈춘다 (BIP44 의 gap limit).
 */
/*
 * 개인키 -> 이 망의 주소. Base58Check(RIPEMD160(SHA256(공개키))).
 * 예전에는 공개키 hex 가 곧 주소였다 — address.js 참고.
 */
const addressOf = privateKey =>
  Address.addressFromPublicKey(getPublicKey(privateKey), addressVersion());

const GAP_LIMIT = 20;
const MAX_SCAN = 1000;

/*
 * 지갑 파일 위치. 기본은 소스 옆의 wallet.json 이지만, 컨테이너에서는
 * 볼륨에 두어야 이미지가 바뀌어도 남는다 (LIMCOIN_WALLET_FILE).
 */
const walletLocation = () => process.env.LIMCOIN_WALLET_FILE || path.join(__dirname, "wallet.json");
// 예전 지갑이 쓰던 파일. 있으면 그 키를 가져온다.
const legacyKeyLocation = () => path.join(__dirname, "privateKey");

// 지갑 파일과, 니모닉에서 뽑아 둔 씨앗을 함께 들고 있는다.
// 씨앗 파생은 PBKDF2 2048회라 매번 하면 아깝다.
let cache = null;

const seedOf = wallet =>
  wallet.mnemonic ? BIP39.mnemonicToSeed(wallet.mnemonic) : wallet.seed;

/*
 * 캐시를 버린다. 지갑 파일이 밖에서 바뀐 경우에 쓴다.
 * (테스트가 파일을 직접 갈아 끼우고 다시 읽게 할 때 필요하다)
 */
const reload = () => {
  cache = null;
};

/*
 * 지갑을 끈 노드. 거래소나 채굴자는 키를 자기 시스템에서 관리하고 노드는
 * 체인만 보게 한다 (LIMCOIN_WALLET=off). 그러면 이 프로세스가 뚫려도
 * 가져갈 키가 없다. 꺼진 상태에서 지갑을 건드리면 여기서 막힌다.
 */
let enabled = true;
const setEnabled = value => {
  enabled = value;
};
const isEnabled = () => enabled;

const readWallet = () => {
  if (!enabled) {
    throw Error("지갑이 꺼져 있습니다 (LIMCOIN_WALLET=off)");
  }
  if (cache !== null) {
    return cache;
  }
  const wallet = JSON.parse(fs.readFileSync(walletLocation(), "utf8"));
  cache = { wallet, seed: seedOf(wallet) };
  return cache;
};

/*
 * 지갑 파일에는 니모닉이 평문으로 들어간다. 그 24단어면 이 지갑의 모든
 * 코인을 가져갈 수 있다. 기본 권한(0644)으로 두면 같은 기계의 다른
 * 사용자가 그냥 읽을 수 있으므로 주인만 읽고 쓰게 한다.
 *
 * 이미 있는 파일은 writeFileSync 의 mode 가 적용되지 않으므로 따로 맞춘다.
 */
const WALLET_MODE = 0o600;

const writeWallet = wallet => {
  cache = { wallet, seed: seedOf(wallet) };
  fs.mkdirSync(path.dirname(walletLocation()), { recursive: true });
  fs.writeFileSync(walletLocation(), JSON.stringify(wallet, null, 2) + "\n", {
    mode: WALLET_MODE
  });
  try {
    fs.chmodSync(walletLocation(), WALLET_MODE);
  } catch (e) {
    // 권한 개념이 없는 파일 시스템(윈도우 등)이면 넘어간다
  }
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
    // 씨앗을 16진수로 두는 대신 니모닉으로 둔다. 사람이 옮겨 적을 수 있고
    // 체크섬이 있어 잘못 적으면 대개 걸린다.
    mnemonic: BIP39.generateMnemonic(),
    // 받는 주소는 바로 쓸 수 있게 하나 미리 만들어 둔다.
    // 거스름돈 주소는 실제로 송금할 때 만든다.
    nextReceive: 1,
    nextChange: 0,
    imported
  });
};

// 백업용 니모닉. v1 지갑(16진수 씨앗)에는 없다.
const getMnemonic = () => readWallet().wallet.mnemonic || null;

const getSeed = () => readWallet().seed;

const getWallet = () => readWallet().wallet;

const deriveAt = (branch, index) =>
  HD.derivePrivateKey(getSeed(), branch, index);

/**
 * 지갑이 가진 모든 키. 받는 주소 + 거스름돈 주소 + 예전 형식에서 가져온 것.
 */
const getAllKeys = () => {
  const { wallet } = readWallet();
  const keys = [];
  for (const [kind, branch, count] of [["receive", HD.RECEIVE, wallet.nextReceive], ["change", HD.CHANGE, wallet.nextChange]]) {
    for (let index = 0; index < count; index++) {
      const privateKey = deriveAt(branch, index);
      keys.push({ kind, index, privateKey, address: addressOf(privateKey) });
    }
  }
  /*
   * 예전 형식 키(imported)는 두 주소로 받을 수 있다. 예전 방식(공개키 hex)
   * 으로 이미 받아 둔 코인과, 새 형식으로 앞으로 받을 코인 둘 다.
   */
  for (const privateKey of wallet.imported || []) {
    keys.push({ kind: "imported", index: null, privateKey, address: getPublicKey(privateKey) });
    keys.push({ kind: "imported", index: null, privateKey, address: addressOf(privateKey) });
  }
  return keys;
};

const getAddresses = () => getAllKeys().map(key => key.address);

// 지금 받는 데 쓰는 주소 (가장 최근에 만든 받는 주소)
const getReceiveAddress = () => {
  const { wallet } = readWallet();
  return addressOf(deriveAt(HD.RECEIVE, wallet.nextReceive - 1));
};

// 받는 주소를 하나 더 만든다
const getNewAddress = () => {
  const { wallet } = readWallet();
  const address = addressOf(deriveAt(HD.RECEIVE, wallet.nextReceive));
  writeWallet({ ...wallet, nextReceive: wallet.nextReceive + 1 });
  return address;
};

/*
 * 거스름돈 주소는 따로 만든다. 이걸 받는 주소와 섞으면 남에게 알려 준
 * 주소로 거스름돈이 돌아와, 주소를 새로 만드는 의미가 없어진다.
 */
const getChangeAddress = () => {
  const { wallet } = readWallet();
  const address = addressOf(deriveAt(HD.CHANGE, wallet.nextChange));
  writeWallet({ ...wallet, nextChange: wallet.nextChange + 1 });
  return address;
};

/**
 * 니모닉으로 지갑을 되살린다.
 *
 * "어디까지 썼는지"는 지갑 파일에만 있고 니모닉에는 없다. 그래서 체인을
 * 보고 찾아야 한다. isUsed 는 그 주소가 체인에 나타난 적 있는지 알려 주는
 * 함수다(노드의 주소 색인).
 *
 * 중간에 안 쓴 주소가 있을 수 있으므로 연속으로 GAP_LIMIT 개가 비어 있을
 * 때까지 훑는다.
 *
 * 기존 지갑을 덮어쓴다. 되살릴 니모닉이 맞는지 먼저 확인할 것.
 */
const restoreFromMnemonic = (mnemonic, isUsed) => {
  if (!BIP39.validateMnemonic(mnemonic)) {
    throw Error("니모닉이 올바르지 않습니다. 단어와 순서를 확인하세요.");
  }
  const seed = BIP39.mnemonicToSeed(mnemonic);

  /*
   * "연속으로" GAP_LIMIT 개가 비어 있을 때까지 훑는다.
   *
   * 처음에는 GAP_LIMIT 개씩 묶어 보고 그 묶음이 통째로 비면 멈추게 했는데,
   * 그러면 어디까지 찾느냐가 묶음 경계에 따라 달라진다. 0..4 와 25 를 쓴
   * 지갑에서 5..24 가 이미 20개 연속으로 비었는데도 25 를 찾아 버렸다.
   * 연속 개수를 직접 세야 한다.
   */
  const scan = branch => {
    let used = 0;
    let consecutiveUnused = 0;
    let index = 0;

    while (consecutiveUnused < GAP_LIMIT && index < MAX_SCAN) {
      // 파생은 묶어서 한다. 마스터/갈래 파생을 매번 다시 하지 않으려는 것뿐이고
      // 멈추는 시점과는 무관하다.
      const batch = HD.deriveRange(seed, branch, index, GAP_LIMIT);
      for (const privateKey of batch) {
        if (isUsed(addressOf(privateKey)) || isUsed(getPublicKey(privateKey))) {
          used = index + 1;
          consecutiveUnused = 0;
        } else {
          consecutiveUnused++;
        }
        index++;
        if (consecutiveUnused >= GAP_LIMIT) {
          break;
        }
      }
    }
    return used;
  };

  /*
   * 예전 형식 키로 받아 둔 코인은 니모닉으로 되살릴 수 없다. 씨앗에서
   * 나온 키가 아니기 때문이다. 예전에는 복구할 때 imported 를 [] 로
   * 덮어써서 그 코인을 통째로 잃었다. 있던 것은 그대로 둔다.
   */
  const imported = fs.existsSync(walletLocation()) ? readWallet().wallet.imported || [] : [];

  const wallet = {
    version: WALLET_VERSION,
    // 단어 사이 공백과 유니코드 표기를 한 가지로 맞춘다 (BIP39 는 NFKD 를 쓴다)
    mnemonic: mnemonic.normalize("NFKD").trim().split(/\s+/).join(" "),
    // 받는 주소는 최소 하나 있어야 쓸 수 있다
    nextReceive: Math.max(1, scan(HD.RECEIVE)),
    nextChange: scan(HD.CHANGE),
    imported
  };
  writeWallet(wallet);
  return { receive: wallet.nextReceive, change: wallet.nextChange };
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

/*
 * 어떤 출력들을 써서 amountNeeded 를 채울 것인가 (코인 선택).
 *
 * 예전에는 배열 순서대로 담다가 채워지면 멈췄다. 순서는 우연이라 큰 출력을
 * 잘게 쪼개 잔돈을 남기기 일쑤였고, 그 잔돈이 쌓이면 다음 송금은 입력이
 * 여러 개가 된다. 여기서 수수료율은 입력 수로 재므로 입력이 많을수록
 * 블록에 담기기도 불리하다.
 *
 * 두 단계로 고른다.
 *   1. 하나로 되는 출력이 있으면 그중 가장 작은 것. 입력 하나, 잔돈 최소.
 *   2. 없으면 큰 것부터 담는다. 입력 수가 가장 적다.
 *
 * 비트코인 코어는 여기에 "잔돈이 안 남는 조합"을 찾는 탐색(Branch and Bound)
 * 을 먼저 한다. 그건 다음 일이다.
 */
/*
 * 이보다 작은 출력은 만들지 않는다 (dust).
 *
 * 여기서 수수료율은 입력 수로 재므로, 어떤 출력이든 나중에 쓸 때 입력
 * 하나 값을 낸다. 그 값에도 못 미치는 잔돈은 있으나 없으나 같고,
 * UTxOut 집합만 불린다. 잔돈이 이보다 작으면 출력을 만들지 않고 수수료로
 * 넘긴다 — 비트코인의 dust 정책과 같다. 1000 lm = 0.00001 LIM.
 */
const DUST = 1000;

/*
 * 정확히(dust 이내로) 채우는 조합을 찾는다 (Branch and Bound).
 *
 * 그런 조합이 있으면 잔돈 출력이 필요 없다. 트랜잭션이 작아지고 UTxOut
 * 하나가 덜 생기며, 어느 출력이 잔돈인지 밖에서 알아볼 수도 없다.
 * 비트코인 코어가 코인 선택 맨 앞에 두는 단계다.
 *
 * 큰 것부터 넣어 보며 깊이 우선으로 훑는다. 남은 것을 다 넣어도 모자라면
 * 그 갈래는 바로 접고(bound), 시도 횟수에 상한을 두어 출력이 많아도
 * 시간이 튀지 않게 한다. 못 찾으면 null — 그때는 예전 방식으로 간다.
 */
const BNB_MAX_TRIES = 100000;

const findExactMatch = (target, utxos, tolerance) => {
  const sorted = [...utxos].sort((a, b) => b.amount - a.amount);
  // 뒤쪽 남은 합 (bound 에 쓴다)
  const remaining = new Array(sorted.length + 1).fill(0);
  for (let i = sorted.length - 1; i >= 0; i--) {
    remaining[i] = remaining[i + 1] + sorted[i].amount;
  }

  let tries = 0;
  const chosen = [];
  const search = (index, sum) => {
    if (sum >= target && sum <= target + tolerance) {
      return true;
    }
    if (sum > target + tolerance || index >= sorted.length) {
      return false;
    }
    if (sum + remaining[index] < target) {
      return false; // 남은 것을 다 넣어도 모자란다
    }
    if (++tries > BNB_MAX_TRIES) {
      return false;
    }
    chosen.push(sorted[index]);
    if (search(index + 1, sum + sorted[index].amount)) {
      return true;
    }
    chosen.pop();
    return search(index + 1, sum);
  };

  return search(0, 0) ? chosen.slice() : null;
};

const findAmountInUTxOuts = (amountNeeded, myUTxOuts) => {
  const exact = findExactMatch(amountNeeded, myUTxOuts, DUST - 1);
  if (exact !== null) {
    const total = exact.reduce((sum, uTxOut) => sum + uTxOut.amount, 0);
    // dust 미만의 초과분은 잔돈 출력을 만들지 않고 수수료로 넘어간다
    return { includedUTxOuts: exact, leftOverAmount: total - amountNeeded };
  }

  const single = myUTxOuts
    .filter(uTxOut => uTxOut.amount >= amountNeeded)
    .sort((a, b) => a.amount - b.amount)[0];
  if (single !== undefined) {
    return { includedUTxOuts: [single], leftOverAmount: single.amount - amountNeeded };
  }

  let currentAmount = 0;
  const includedUTxOuts = [];
  for (const myUTxOut of [...myUTxOuts].sort((a, b) => b.amount - a.amount)) {
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
  // dust 미만의 잔돈은 출력으로 만들지 않는다. 그 몫은 수수료가 된다.
  if (leftOverAmount < DUST) {
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
  if (amount < DUST) {
    // 받는 쪽이 나중에 쓸 때 드는 값에도 못 미치는 출력이다
    throw Error(`보내는 금액은 최소 ${DUST} lm 이상이어야 합니다 (dust)`);
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
  const changeAddress = leftOverAmount >= DUST ? getChangeAddress() : null;
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
  getWallet,
  getMnemonic,
  restoreFromMnemonic,
  reload,
  setEnabled,
  isEnabled,
  findAmountInUTxOuts,
  findExactMatch,
  DUST,
  GAP_LIMIT,
  getAllKeys,
  addressOf,
  getAddresses,
  getReceiveAddress,
  getNewAddress,
  getChangeAddress,
  getPublicFromWallet,
  getBalance,
  getWalletBalance,
  createTx
};
