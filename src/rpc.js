/**
 * 비트코인 호환 JSON-RPC.
 *
 * REST API 만 있었다. 형식은 깔끔하지만 거래소·결제 업체의 연동 도구는 대개
 * 비트코인 코어의 JSON-RPC(`getblockcount`, `sendrawtransaction` …)를 전제로
 * 만들어져 있다. 우리만의 REST 를 쓰라고 하면 상대가 연동을 새로 짜야 하고,
 * 그게 상장 심사에서 실제로 걸리는 마찰이다.
 *
 * 그래서 같은 노드가 두 얼굴을 갖는다. 안쪽은 그대로 두고, 이름과 응답
 * 모양만 저쪽 관례에 맞춘 껍데기를 씌운다.
 *
 *   POST /rpc   { "jsonrpc": "2.0", "id": 1, "method": "getblockcount" }
 *
 * 다른 점은 정직하게 적어 둔다.
 *
 *   - 금액은 LIM 소수다(비트코인이 BTC 소수를 쓰는 것과 같다). 안쪽에서는
 *     최소 단위(lm) 정수로 다룬다.
 *   - 우리 트랜잭션에는 스크립트 대신 주소가 들어간다. vout 의
 *     scriptPubKey 는 주소를 담은 흉내이고, hex 는 없다.
 *   - sequence, tx version, segwit 은 없다.
 */
const Blockchain = require("./blockchain");
const Mempool = require("./memPool");
const Wallet = require("./wallet");
const Transactions = require("./transactions");
const AddressIndex = require("./addressIndex");
const Address = require("./address");
const Params = require("./params");
const Target = require("./target");
const P2P = require("./p2p");
const Transport = require("./transport");
const S = require("./serialization");
const { formatLim, parseLim } = require("./units");
const { indexByOutpoint, keyOf } = require("./utxo");

// 비트코인 코어의 오류 코드. 상대 도구가 이 숫자를 보고 갈래를 탄다.
const ERROR = {
  MISC: -1,
  TYPE: -3,
  WALLET: -4,
  INVALID_ADDRESS_OR_KEY: -5,
  INVALID_PARAMETER: -8,
  WALLET_UNLOCK_NEEDED: -13,
  VERIFY_REJECTED: -26,
  VERIFY_ALREADY_IN_CHAIN: -27,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603
};

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new RpcError(code, message);
};

/* ------------------------------------------- 값 옮기기 */

// 최소 단위(lm) -> LIM 소수. 비트코인 RPC 가 BTC 소수를 주는 것과 같다.
const toLim = amount => Number(formatLim(amount));

// LIM 소수 -> lm 정수. 숫자로 와도 문자열로 와도 받는다.
const fromLim = value => {
  if (typeof value !== "number" && typeof value !== "string") {
    fail(ERROR.TYPE, "금액은 숫자여야 합니다");
  }
  try {
    return parseLim(String(value));
  } catch {
    fail(ERROR.TYPE, `금액이 올바르지 않습니다: ${value}`);
  }
};

const addressVersion = () => Params.current().addressVersion;
const scriptVersion = () => Params.current().scriptAddressVersion;

// 주소가 어떤 꼴인지 (비트코인의 scriptPubKey.type 자리)
const addressType = address => {
  if (Address.scriptHashOf(address, scriptVersion()) !== null) {
    return "scripthash";
  }
  if (Address.isLegacyAddress(address)) {
    return "pubkey";
  }
  return Address.isBase58Address(address, addressVersion()) ? "pubkeyhash" : "nonstandard";
};

/*
 * 우리 트랜잭션을 비트코인 모양으로 옮긴다.
 *
 * 입금 감시 도구는 대개 vout[].value 와 scriptPubKey.address 만 본다.
 * 그 둘이 맞으면 대부분 그대로 돈다.
 */
const toBitcoinTx = (tx, context = {}) => {
  const raw = S.encodeTx(tx);
  const coinbase = Transactions.isCoinbaseTx(tx);
  return {
    txid: tx.id,
    hash: tx.id, // segwit 이 없으므로 둘이 같다
    version: 1,
    size: raw.length / 2,
    vsize: raw.length / 2,
    locktime: tx.lockTime || 0,
    vin: tx.txIns.map(txIn =>
      coinbase
        ? { coinbase: String(txIn.txOutIndex), sequence: 0xffffffff }
        : {
            txid: txIn.txOutId,
            vout: txIn.txOutIndex,
            // 우리에게는 스크립트가 없다. 해제 데이터를 그 자리에 보여 준다.
            scriptSig: { asm: "", hex: txIn.signature || "" },
            ...(txIn.publicKey ? { publicKey: txIn.publicKey } : {}),
            ...(txIn.redeemScript ? { redeemScript: txIn.redeemScript } : {}),
            ...(txIn.unlock ? { unlock: txIn.unlock } : {}),
            sequence: 0xffffffff
          }
    ),
    vout: tx.txOuts.map((txOut, n) => ({
      value: toLim(txOut.amount),
      n,
      scriptPubKey: {
        address: txOut.address,
        addresses: [txOut.address],
        type: addressType(txOut.address),
        asm: "",
        hex: ""
      }
    })),
    hex: raw,
    ...context
  };
};

const tipHeight = () => Blockchain.getNewestBlock().index;

const confirmationsFor = height =>
  typeof height === "number" ? tipHeight() - height + 1 : 0;

const blockToJson = (block, verbosity) => {
  const chain = Blockchain.getBlockChain();
  const next = chain[block.index + 1];
  // 한 번만 직렬화한다 — size/strippedsize/weight 가 같은 값을 쓴다
  const rawBytes = S.encodeBlock(block).length / 2;
  const base = {
    hash: block.hash,
    confirmations: confirmationsFor(block.index),
    height: block.index,
    version: block.version,
    versionHex: block.version.toString(16).padStart(8, "0"),
    merkleroot: block.merkleRoot,
    time: block.timestamp,
    // MTP 는 직전 11블록만 본다. 앞부분을 통째로 넘기면 높이만큼 복사가 든다.
    mediantime: Blockchain.medianTimePast(
      chain.slice(Math.max(0, block.index + 1 - Blockchain.MEDIAN_TIME_SPAN), block.index + 1)
    ),
    nonce: block.nonce,
    // 8자리로 채운다 — 고정 폭으로 읽는 도구가 있다 (비트코인도 8자리다)
    bits: (block.bits >>> 0).toString(16).padStart(8, "0"),
    difficulty: Target.difficultyOf(block.bits),
    chainwork: Blockchain.workUpTo(block.index).toString(16),
    nTx: block.data.length,
    previousblockhash: block.index === 0 ? undefined : block.previousHash,
    nextblockhash: next ? next.hash : undefined,
    size: rawBytes,
    strippedsize: rawBytes,
    weight: rawBytes
  };
  if (verbosity >= 2) {
    return {
      ...base,
      tx: block.data.map(tx =>
        toBitcoinTx(tx, {
          blockhash: block.hash,
          confirmations: base.confirmations,
          time: block.timestamp,
          blocktime: block.timestamp
        })
      )
    };
  }
  return { ...base, tx: block.data.map(tx => tx.id) };
};

/* ------------------------------------------- 인자 다루기 */

// 위치 인자(배열)와 이름 인자(객체)를 모두 받는다 (비트코인 코어와 같다)
const argsOf = (params, names) => {
  if (params === undefined || params === null) {
    return [];
  }
  if (Array.isArray(params)) {
    return params;
  }
  if (typeof params === "object") {
    return names.map(name => params[name]);
  }
  fail(ERROR.INVALID_PARAMS, "params 는 배열이나 객체여야 합니다");
};

const wantHash = value => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    fail(ERROR.INVALID_ADDRESS_OR_KEY, "32바이트 hex 해시가 아닙니다");
  }
  return value.toLowerCase();
};

const wantHeight = value => {
  if (!Number.isInteger(value) || value < 0) {
    fail(ERROR.INVALID_PARAMETER, "높이는 0 이상의 정수여야 합니다");
  }
  return value;
};

/* ------------------------------------------- 메서드 */

const methods = {};
// wallet: true 면 지갑 토큰이 필요하다
const define = (name, names, handler, options = {}) => {
  methods[name] = { names, handler, wallet: options.wallet === true };
};

/* --- 체인 --- */

define("getblockcount", [], () => tipHeight());

define("getbestblockhash", [], () => Blockchain.getNewestBlock().hash);

define("getblockhash", ["height"], params => {
  const [height] = argsOf(params, ["height"]);
  const block = Blockchain.getBlockByHeight(wantHeight(height));
  if (!block) {
    fail(ERROR.INVALID_PARAMETER, "그 높이의 블록이 없습니다");
  }
  return block.hash;
});

define("getblock", ["blockhash", "verbosity"], params => {
  const [hash, verbosity = 1] = argsOf(params, ["blockhash", "verbosity"]);
  const block = Blockchain.getBlockByHash(wantHash(hash));
  if (!block) {
    fail(ERROR.INVALID_ADDRESS_OR_KEY, "그 블록을 모릅니다");
  }
  const level = verbosity === true ? 1 : verbosity === false ? 0 : verbosity;
  if (level === 0) {
    return S.encodeBlock(block);
  }
  return blockToJson(block, level);
});

define("getblockheader", ["blockhash", "verbose"], params => {
  const [hash, verbose = true] = argsOf(params, ["blockhash", "verbose"]);
  const block = Blockchain.getBlockByHash(wantHash(hash));
  if (!block) {
    fail(ERROR.INVALID_ADDRESS_OR_KEY, "그 블록을 모릅니다");
  }
  if (verbose === false) {
    return S.serializeHeader(block).toString("hex");
  }
  // tx 목록만 뺀다 — 헤더에는 개수(nTx)만 실린다 (비트코인과 같다)
  const full = blockToJson(block, 1);
  delete full.tx;
  return full;
});

define("getblockchaininfo", [], () => {
  const tip = Blockchain.getNewestBlock();
  const chain = Blockchain.getBlockChain();
  return {
    chain: Params.current().name,
    blocks: tip.index,
    headers: tip.index,
    bestblockhash: tip.hash,
    difficulty: Target.difficultyOf(tip.bits),
    time: tip.timestamp,
    mediantime: Blockchain.medianTimePast(chain),
    verificationprogress: 1,
    initialblockdownload: false,
    chainwork: Blockchain.tipWork().toString(16),
    pruned: false,
    warnings: ""
  };
});

define("getdifficulty", [], () => Target.difficultyOf(Blockchain.getNewestBlock().bits));

define("getchaintips", [], () => {
  const tip = Blockchain.getNewestBlock();
  return [{ height: tip.index, hash: tip.hash, branchlen: 0, status: "active" }];
});

/* --- 트랜잭션 --- */

define("getrawtransaction", ["txid", "verbose"], params => {
  const [txid, verbose = false] = argsOf(params, ["txid", "verbose"]);
  const found = Blockchain.findTx(wantHash(txid));
  if (!found) {
    fail(
      ERROR.INVALID_ADDRESS_OR_KEY,
      "그 트랜잭션을 모릅니다. 색인에 없거나 mempool 에 없습니다."
    );
  }
  const raw = S.encodeTx(found.tx);
  if (verbose === false || verbose === 0) {
    return raw;
  }
  const context = found.pending
    ? { confirmations: 0, in_active_chain: false }
    : {
        blockhash: found.block.hash,
        blockheight: found.block.index,
        confirmations: confirmationsFor(found.block.index),
        time: found.block.timestamp,
        blocktime: found.block.timestamp,
        in_active_chain: true
      };
  return toBitcoinTx(found.tx, context);
});

define("decoderawtransaction", ["hexstring"], params => {
  const [hex] = argsOf(params, ["hexstring"]);
  try {
    return toBitcoinTx(S.decodeTx(hex));
  } catch (e) {
    fail(ERROR.INVALID_PARAMETER, `raw 트랜잭션을 읽을 수 없습니다: ${e.message}`);
  }
});

define("sendrawtransaction", ["hexstring"], params => {
  const [hex] = argsOf(params, ["hexstring"]);
  let tx;
  try {
    tx = S.decodeTx(hex);
  } catch (e) {
    fail(ERROR.INVALID_PARAMETER, `raw 트랜잭션을 읽을 수 없습니다: ${e.message}`);
  }
  if (Blockchain.findTx(tx.id)) {
    fail(ERROR.VERIFY_ALREADY_IN_CHAIN, "이미 알고 있는 트랜잭션입니다");
  }
  try {
    return Blockchain.submitTx(tx).id;
  } catch (e) {
    fail(ERROR.VERIFY_REJECTED, e.message);
  }
});

define("gettxout", ["txid", "n", "include_mempool"], params => {
  const [txid, n, includeMempool = true] = argsOf(params, ["txid", "n", "include_mempool"]);
  const confirmed = Blockchain.getUTxOutList();
  const source = includeMempool === false ? confirmed : Mempool.getSpendableUTxOuts(confirmed);
  const found = indexByOutpoint(source).get(keyOf(wantHash(txid), n));
  if (found === undefined) {
    return null; // 이미 쓰였거나 없는 출력 — 비트코인도 null 을 준다
  }
  return {
    bestblock: Blockchain.getNewestBlock().hash,
    confirmations: found.blockIndex === null ? 0 : confirmationsFor(found.blockIndex),
    value: toLim(found.amount),
    scriptPubKey: {
      address: found.address,
      addresses: [found.address],
      type: addressType(found.address),
      asm: "",
      hex: ""
    },
    coinbase: Boolean(found.coinbase)
  };
});

define("validateaddress", ["address"], params => {
  const [address] = argsOf(params, ["address"]);
  const valid = typeof address === "string" && Transactions.isAddressValid(address);
  if (!valid) {
    return { isvalid: false };
  }
  return {
    isvalid: true,
    address,
    isscript: addressType(address) === "scripthash",
    iswitness: false,
    type: addressType(address)
  };
});

/* --- mempool --- */

define("getrawmempool", ["verbose"], params => {
  const [verbose = false] = argsOf(params, ["verbose"]);
  const pool = Mempool.getMempool();
  if (verbose !== true) {
    return pool.map(tx => tx.id);
  }
  const sources = indexByOutpoint(Mempool.getSpendableUTxOuts(Blockchain.getUTxOutList()));
  const now = Math.round(Date.now() / 1000);
  return Object.fromEntries(
    pool.map(tx => [
      tx.id,
      {
        vsize: Transactions.getTxSize(tx),
        weight: Transactions.getTxSize(tx),
        fee: toLim(Math.max(0, Transactions.getTxFee(tx, sources))),
        time: now,
        height: tipHeight(),
        depends: tx.txIns
          .map(txIn => txIn.txOutId)
          .filter(id => pool.some(other => other.id === id))
      }
    ])
  );
});

define("getmempoolinfo", [], () => ({
  loaded: true,
  size: Mempool.getMempool().length,
  bytes: Mempool.poolBytes(),
  usage: Mempool.poolBytes(),
  maxmempool: Mempool.MAX_MEMPOOL_BYTES,
  mempoolminfee: toLim(Transactions.MIN_RELAY_FEE_RATE * 1000),
  minrelaytxfee: toLim(Transactions.MIN_RELAY_FEE_RATE * 1000)
}));

define("estimatesmartfee", ["conf_target"], params => {
  const [target = 1] = argsOf(params, ["conf_target"]);
  const estimate = Mempool.estimateFee(Blockchain.getUTxOutList(), Transactions.MAX_BLOCK_BYTES);
  return {
    // 비트코인은 kB 당 값을 준다
    feerate: toLim(estimate.perByte * 1000),
    blocks: Number.isInteger(target) && target > 0 ? target : 1
  };
});

/* --- 망 --- */

define("getconnectioncount", [], () => P2P.getPeers().length);

define("getnetworkinfo", [], () => ({
  version: 1000000,
  subversion: `/LimCoin:${require("../package.json").version || "1.0.0"}/`,
  protocolversion: 1,
  localservices: "0000000000000000",
  connections: P2P.getPeers().length,
  networkactive: true,
  networks: [{ name: "ipv4", limited: false, reachable: true, proxy: "" }],
  relayfee: toLim(Transactions.MIN_RELAY_FEE_RATE * 1000),
  incrementalfee: toLim(Transactions.MIN_RELAY_FEE_RATE * 1000),
  localaddresses: [],
  // 우리 쪽에만 있는 것 — 전송 암호화와 노드 신원
  nodeid: Transport.nodeId(),
  encryption: Transport.mode(),
  warnings: ""
}));

define("getpeerinfo", [], () =>
  P2P.getPeerInfo().map((peer, id) => ({
    id,
    addr: peer.url || "inbound",
    inbound: peer.inbound,
    encrypted: peer.encrypted,
    nodeid: peer.peerId
  }))
);

define("uptime", [], () => Math.round(process.uptime()));

/* --- 지갑 (토큰 필요) --- */

const requireUnlocked = () => {
  if (!Wallet.isEnabled()) {
    fail(ERROR.WALLET, "이 노드는 지갑 없이 돕니다 (LIMCOIN_WALLET=off)");
  }
  if (Wallet.isLocked()) {
    fail(ERROR.WALLET_UNLOCK_NEEDED, "지갑이 잠겨 있습니다. walletpassphrase 로 푸세요.");
  }
};

define(
  "getwalletinfo",
  [],
  () => {
    requireUnlocked();
    const mine = new Set(Wallet.getAddresses());
    // 아직 블록에 안 담긴 내 앞으로의 출력 (mempool 것)
    const unconfirmed = Mempool.getSpendableUTxOuts(Blockchain.getUTxOutList())
      .filter(uTxOut => uTxOut.blockIndex === null && mine.has(uTxOut.address))
      .reduce((sum, uTxOut) => sum + uTxOut.amount, 0);
    return {
      walletname: "",
      walletversion: 3,
      balance: toLim(Blockchain.getSpendableBalance()),
      unconfirmed_balance: toLim(unconfirmed),
      immature_balance: toLim(Blockchain.getImmatureBalance()),
      // 이 지갑의 트랜잭션 수. 예전에는 노드 전체의 색인된 주소 수를 줬다 —
      // 이름과 전혀 다른 값이라, 읽는 쪽이 그대로 믿으면 틀린다.
      txcount: [...mine].reduce(
        (total, address) => total + AddressIndex.getTransactionCount(address),
        0
      ),
      keypoolsize: mine.size,
      paytxfee: 0,
      encrypted: Wallet.isEncrypted(),
      unlocked: !Wallet.isLocked()
    };
  },
  { wallet: true }
);

define(
  "getnewaddress",
  [],
  () => {
    requireUnlocked();
    return Wallet.getNewAddress();
  },
  { wallet: true }
);

define(
  "getbalance",
  [],
  () => {
    requireUnlocked();
    return toLim(Blockchain.getSpendableBalance());
  },
  { wallet: true }
);

define(
  "sendtoaddress",
  ["address", "amount"],
  params => {
    requireUnlocked();
    const [address, amount] = argsOf(params, ["address", "amount"]);
    if (typeof address !== "string" || !Transactions.isAddressValid(address)) {
      fail(ERROR.INVALID_ADDRESS_OR_KEY, "이 망의 주소가 아닙니다");
    }
    try {
      // 수수료를 주지 않았으므로 지금 권장값으로 보낸다
      const rate = Mempool.estimateFee(
        Blockchain.getUTxOutList(),
        Transactions.MAX_BLOCK_BYTES
      ).perByte;
      return Blockchain.sendTx(address, fromLim(amount), 0, rate).id;
    } catch (e) {
      fail(ERROR.WALLET, e.message);
    }
  },
  { wallet: true }
);

/*
 * listunspent(minconf, maxconf, addresses)
 *
 * 세 인자를 다 받는다. 예전에는 minconf 만 보고 나머지를 조용히 버렸는데,
 * `listunspent 1 9999999 ["주소"]` 처럼 부르는 것이 흔하다 — 그러면 그 주소
 * 것만 달라고 한 요청에 지갑 전체를 돌려주게 되고, 받는 쪽은 남의 출력을
 * 그 주소 몫으로 센다. 무시하는 쪽이 더 많이 주는 방향이라 더 나쁘다.
 */
define(
  "listunspent",
  ["minconf", "maxconf", "addresses"],
  params => {
    requireUnlocked();
    const [minconf = 1, maxconf = 9999999, addresses] = argsOf(params, [
      "minconf",
      "maxconf",
      "addresses"
    ]);
    const low = Number.isInteger(minconf) ? minconf : 1;
    const high = Number.isInteger(maxconf) ? maxconf : 9999999;
    if (addresses !== undefined && addresses !== null && !Array.isArray(addresses)) {
      fail(ERROR.TYPE, "addresses 는 주소 배열이어야 합니다");
    }
    const mine = new Set(Wallet.getAddresses());
    // 주소를 줬으면 그 안에서만. 내 것이 아닌 주소를 물으면 빈 목록이 맞다.
    const wanted = Array.isArray(addresses) ? new Set(addresses.filter(a => mine.has(a))) : mine;
    return Blockchain.getUTxOutList()
      .filter(uTxOut => wanted.has(uTxOut.address))
      .map(uTxOut => ({
        txid: uTxOut.txOutId,
        vout: uTxOut.txOutIndex,
        address: uTxOut.address,
        amount: toLim(uTxOut.amount),
        confirmations: uTxOut.blockIndex === null ? 0 : confirmationsFor(uTxOut.blockIndex),
        spendable: true,
        solvable: true,
        safe: true
      }))
      .filter(entry => entry.confirmations >= low && entry.confirmations <= high);
  },
  { wallet: true }
);

define(
  "listtransactions",
  ["label", "count", "skip"],
  params => {
    requireUnlocked();
    const [, count = 10, skip = 0] = argsOf(params, ["label", "count", "skip"]);
    if (!Number.isInteger(count) || count < 0 || !Number.isInteger(skip) || skip < 0) {
      fail(ERROR.INVALID_PARAMETER, "count 와 skip 은 0 이상의 정수여야 합니다");
    }
    const rows = [];
    for (const address of Wallet.getAddresses()) {
      const { transactions } = AddressIndex.getTransactions(address, 1000, 0);
      for (const entry of transactions) {
        rows.push({
          address,
          category: entry.received > 0 ? "receive" : "send",
          amount: toLim(entry.received > 0 ? entry.received : -entry.sent),
          confirmations: confirmationsFor(entry.blockIndex),
          blockheight: entry.blockIndex,
          txid: entry.txId,
          time: entry.timestamp
        });
      }
    }
    rows.sort((a, b) => b.blockheight - a.blockheight);
    return rows.slice(skip, skip + count);
  },
  { wallet: true }
);

/*
 * walletpassphrase(passphrase, timeout)
 *
 * timeout 초 뒤에 스스로 다시 잠근다. 예전에는 이 인자를 받기만 하고 버려서,
 * `walletpassphrase(pw, 60)` 을 부른 쪽은 1분 뒤 잠긴 줄 알지만 지갑은 계속
 * 열려 있었다. 잠금은 지키는 쪽으로 틀려야 한다.
 */
const MAX_UNLOCK_SECONDS = 24 * 60 * 60;
let relockTimer = null;

const cancelRelock = () => {
  if (relockTimer !== null) {
    clearTimeout(relockTimer);
    relockTimer = null;
  }
};

define(
  "walletpassphrase",
  ["passphrase", "timeout"],
  params => {
    const [passphrase, timeout] = argsOf(params, ["passphrase", "timeout"]);
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
      fail(ERROR.INVALID_PARAMETER, "timeout 은 양의 정수(초)여야 합니다");
    }
    try {
      Wallet.unlock(passphrase);
    } catch (e) {
      fail(ERROR.WALLET, e.message);
    }
    cancelRelock();
    if (timeout !== undefined) {
      const seconds = Math.min(timeout, MAX_UNLOCK_SECONDS);
      relockTimer = setTimeout(() => {
        relockTimer = null;
        Wallet.lock();
        console.log(`지갑을 다시 잠갔습니다 (walletpassphrase timeout ${seconds}초)`);
      }, seconds * 1000);
      // 이 타이머 때문에 노드가 안 꺼지면 안 된다
      if (typeof relockTimer.unref === "function") {
        relockTimer.unref();
      }
    }
    return null;
  },
  { wallet: true }
);

define(
  "walletlock",
  [],
  () => {
    cancelRelock();
    Wallet.lock();
    return null;
  },
  { wallet: true }
);

/* ------------------------------------------- 부르기 */

const helpText = () =>
  Object.keys(methods)
    .sort()
    .map(name => `${name}${methods[name].wallet ? " (지갑 토큰 필요)" : ""}`);

define("help", [], () => helpText().join("\n"));

/*
 * 요청 하나를 처리한다. authorized 는 지갑 토큰이 확인되었는지.
 */
const callOne = (request, authorized) => {
  const id = request && request.id !== undefined ? request.id : null;
  const answer = (result, error) => ({ result: error ? null : result, error: error || null, id });

  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return answer(null, { code: ERROR.INVALID_REQUEST, message: "요청이 객체가 아닙니다" });
  }
  if (typeof request.method !== "string") {
    return answer(null, { code: ERROR.INVALID_REQUEST, message: "method 가 없습니다" });
  }
  const method = methods[request.method];
  if (method === undefined) {
    return answer(null, {
      code: ERROR.METHOD_NOT_FOUND,
      message: `모르는 메서드입니다: ${request.method}. help 를 부르면 목록을 줍니다.`
    });
  }
  if (method.wallet && !authorized) {
    return answer(null, {
      code: ERROR.WALLET,
      message: "이 메서드는 지갑 토큰이 필요합니다 (Authorization: Bearer …)"
    });
  }
  try {
    return answer(method.handler(request.params));
  } catch (e) {
    if (e instanceof RpcError) {
      return answer(null, { code: e.code, message: e.message });
    }
    console.log(`RPC ${request.method} 처리 중 문제: ${e.message}`);
    return answer(null, { code: ERROR.INTERNAL, message: e.message });
  }
};

// 배치(배열)도 받는다
const call = (body, authorized) => {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { result: null, error: { code: ERROR.INVALID_REQUEST, message: "빈 배치" }, id: null };
    }
    return body.map(request => callOne(request, authorized));
  }
  return callOne(body, authorized);
};

// 지갑 메서드가 하나라도 들어 있는가 (토큰을 요구할지 정할 때)
const needsWallet = body => {
  const one = request =>
    request !== null &&
    typeof request === "object" &&
    methods[request.method] !== undefined &&
    methods[request.method].wallet;
  return Array.isArray(body) ? body.some(one) : one(body);
};

module.exports = { call, needsWallet, methods, ERROR, toBitcoinTx, helpText };
