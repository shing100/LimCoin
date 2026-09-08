const express = require("express"),
    bodyParser = require("body-parser"),
    cors = require("cors"),
    morgan = require("morgan"),
    Blockchain = require("./blockchain"),
    Mempool = require("./memPool"),
    P2P = require("./p2p"),
    Wallet = require("./wallet"),
    Transactions = require("./transactions"),
    Miner = require("./miner"),
    AddressIndex = require("./addressIndex"),
    ChainIndex = require("./chainIndex"),
    crypto = require("crypto");

const {
  getBlockChain, createNewBlock, getAccountBalance, getSpendableBalance,
  getImmatureBalance, sendTx, getUTxOutList, persistMempool,
  getTxProof, getNewestBlock, initChain, getBlockByHash, findTx
} = Blockchain;
const { getTxFee } = Transactions;
const { indexByOutpoint, indexByAddress } = require("./utxo");
const { startP2PServer, setPublicUrl, connectToPeers, disconnectPeer, getPeers, getKnownAddresses } = P2P;
const { initWallet, getReceiveAddress, getNewAddress, getAddresses, getBalance, getMnemonic, restoreFromMnemonic, GAP_LIMIT } = Wallet;
const AddressIndexApi = require("./addressIndex");
const { getMempool } = Mempool;
const {
  isAddressValid, getBlockSubsidy, getTotalSupply,
  HALVING_INTERVAL, INITIAL_SUBSIDY, MAX_TXS_PER_BLOCK, COINBASE_MATURITY
} = Transactions;
const { COIN, DECIMALS } = require("./units");

const PORT = process.env.HTTP_PORT || 3000;

/*
 * 공개 API 와 지갑 API 를 나눈다.
 *
 * 지금까지는 /blocks 같은 읽기 전용 엔드포인트와 "이 노드의 지갑에서
 * 돈을 빼는" /me/*, POST /transactions 가 같은 앱에 얹혀 있었다. 게다가
 * cors() 가 와일드카드라, 아무 웹페이지나 방문자의 로컬 노드에 송금
 * 요청을 보낼 수 있었다.
 *
 *  - 공개(읽기)  : CORS 허용. 익스플로러가 붙어야 한다.
 *  - 지갑(쓰기)  : CORS 차단 + 토큰. 브라우저에서 건드릴 수 없다.
 *
 * 토큰은 뜰 때 만들어 콘솔에 찍는다. LIMCOIN_WALLET_TOKEN 으로 고정할 수
 * 있고, LIMCOIN_WALLET_TOKEN=none 이면 인증을 끈다(로컬 실습용).
 */
const WALLET_TOKEN =
  process.env.LIMCOIN_WALLET_TOKEN || crypto.randomBytes(24).toString("hex");
const AUTH_DISABLED = WALLET_TOKEN === "none";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));
app.use(morgan("combined"));

// X-Total-Count 는 단순 응답 헤더가 아니라서, 명시적으로 노출하지 않으면
// 교차 출처에서 읽을 수 없다. 익스플로러의 페이지네이션이 이 값에 기댄다.
const allowCors = cors({ exposedHeaders: ["X-Total-Count"] });
const readOnly = ["/blocks", "/transactions", "/peers", "/address", "/info", "/search", "/fees"];

app.use((req, res, next) => {
  // 읽기 전용은 누구에게나 연다. 익스플로러가 붙어야 한다.
  if (readOnly.some(prefix => req.path.startsWith(prefix)) && req.method === "GET") {
    return allowCors(req, res, next);
  }

  /*
   * 지갑 엔드포인트의 교차 출처는 토큰이 켜져 있을 때만 허용한다.
   *
   * 지갑 UI 는 노드와 다른 출처에서 뜬다 — 개발 중에는 React 개발서버가,
   * Electron 에서는 노드가 임의 포트를 쓴다. 무조건 막으면 정작 지갑이
   * 자기 노드에 붙지 못한다.
   *
   * 진짜 방어선은 토큰이다. 남의 웹페이지는 토큰을 알 수 없으므로 요청이
   * 가더라도 401 로 막힌다. 반대로 인증을 꺼 둔 상태(none)에서 교차 출처를
   * 열어 주면 아무 웹페이지나 이 노드를 조작할 수 있으니, 그때는 막는다.
   */
  if (!AUTH_DISABLED) {
    return allowCors(req, res, next);
  }
  next();
});

/*
 * 토큰 비교는 상수 시간으로 한다.
 *
 * !== 로 비교하면 앞에서 몇 글자가 맞았는지에 따라 걸리는 시간이 달라져서,
 * 이론적으로는 한 글자씩 알아낼 수 있다. 로컬 노드 상대로는 네트워크 지연에
 * 묻히지만, 맞게 하는 데 드는 비용이 없다.
 *
 * timingSafeEqual 은 길이가 다르면 던지므로 먼저 해시해 길이를 맞춘다.
 */
const tokenMatches = candidate => {
  const digest = value => crypto.createHash("sha256").update(String(value)).digest();
  return crypto.timingSafeEqual(digest(candidate), digest(WALLET_TOKEN));
};

// 지갑을 건드리는 요청은 토큰을 요구한다
const requireWalletAuth = (req, res, next) => {
  if (AUTH_DISABLED) {
    return next();
  }
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : req.get("X-Wallet-Token") || "";

  if (!tokenMatches(token)) {
    res.status(401).send("이 엔드포인트는 지갑 토큰이 필요합니다");
    return;
  }
  next();
};

/*
 * 예전에는 체인 전체를 그대로 돌려줬다. 익스플로러는 그걸 받아 앞의
 * 15개만 썼다. 블록이 수만 개가 되면 그대로 무너진다.
 *
 * 기본은 최신순 50개. ?limit / ?offset 으로 넘긴다. 전체 개수는
 * X-Total-Count 헤더에 담는다.
 */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;

const clampInt = (value, fallback, max) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(n, max);
};

app.route("/blocks").get((req, res) => {
  const chain = getBlockChain();
  const limit = clampInt(req.query.limit, DEFAULT_PAGE, MAX_PAGE);
  const offset = clampInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
  /*
   * 최신 블록이 앞으로 오게 잘라 준다.
   *
   * 예전에는 체인을 통째로 복사해 뒤집은 다음 잘랐다. 익스플로러가
   * 4초마다 부르는 자리에서 체인 길이에 비례하는 값을 낼 이유가 없다.
   * 필요한 구간만 끝에서 떼어 뒤집는다.
   */
  const end = Math.max(0, chain.length - offset);
  const start = Math.max(0, end - limit);
  const page = chain.slice(start, end).reverse();
  res.set("X-Total-Count", String(chain.length));
  res.send(page);
}).post(requireWalletAuth, async (req, res) => {
  try {
    res.send(await createNewBlock());
  } catch (e) {
    res.status(400).send(e.message);
  }
});

/*
 * 피어 연결.
 *
 * 붙이는 것은 지갑 권한이 필요하다. 예전에는 아무나 POST /peers 로 이 노드를
 * 임의의 주소에 연결시킬 수 있었다 — 피어 상한(32)을 쓰레기로 채워 진짜
 * 피어가 못 붙게 하거나, 악성 피어에 붙여 놓을 수 있었다. 주소 형식은
 * connectToPeers 가 본다(ws:// 또는 wss://).
 */
// 아는 주소 전부 (아직 붙지 않은 것 포함). 피어에게 배운 것이 여기 쌓인다.
app.get("/peers/known", (req, res) => {
  res.send(getKnownAddresses());
});

app.route("/peers")
  .get((req, res) => {
    res.send(getPeers());
  })
  .post(requireWalletAuth, (req, res) => {
    try {
      const { body: { peer } } = req;
      if (peer === undefined) {
        throw Error("Please specify a peer");
      }
      connectToPeers(peer);
      res.send();
    } catch (e) {
      res.status(400).send(e.message);
    }
  })
  // 걸어 둔 피어를 잊는다. 끊기면 다시 거는 것도 멈춘다.
  .delete(requireWalletAuth, (req, res) => {
    const { body: { peer } } = req;
    if (!disconnectPeer(peer)) {
      res.status(404).send("우리가 걸어 둔 피어가 아닙니다");
      return;
    }
    res.send();
  });

/*
 * 잔액.
 *
 * balance 는 블록에 담긴 것만 센 확정 잔액이고, spendable 은 mempool 까지
 * 반영해 지금 실제로 보낼 수 있는 금액이다. 보내고 나면 그 코인은 아직
 * 블록에 없지만 이미 남에게 간 것이라, 확정 잔액만 보여 주면 없는 돈이
 * 있는 것처럼 보인다.
 */
app.get("/me/balance", requireWalletAuth, (req, res) => {
  res.send({
    balance: getAccountBalance(),
    spendable: getSpendableBalance(),
    // 아직 묻히지 않아 쓸 수 없는 채굴 보상
    immature: getImmatureBalance(),
    coinbaseMaturity: COINBASE_MATURITY
  });
});

app.get("/me/address", requireWalletAuth, (req,res) => {
  res.send(getReceiveAddress());
});

/*
 * 지갑이 가진 모든 주소와 각각의 잔액.
 *
 * 백서 10장대로 거스름돈을 새 주소로 받으므로, 지갑은 주소를 여러 개
 * 갖게 된다. "내 주소"가 하나뿐이라는 전제가 더는 성립하지 않는다.
 */
app.get("/me/addresses", requireWalletAuth, (req, res) => {
  // 주소마다 UTxOut 전체를 훑으면 주소 수 x UTxOut 수다.
  // 색인을 한 번만 만들면 한 번 훑는 것으로 끝난다.
  const balances = indexByAddress(getUTxOutList());
  res.send(
    getAddresses().map(address => ({
      address,
      balance: balances.get(address) || 0
    }))
  );
});

/*
 * 아직 블록에 담기지 않은, 내 지갑이 얽힌 트랜잭션.
 *
 * 지갑은 지금까지 확정된 내역만 볼 수 있었다. 보내고 나면 블록이 나올
 * 때까지 아무 흔적도 없어서, 보내진 건지 알 수 없었다.
 *
 * "얼마를 썼는가"는 입력이 가리키는 이전 출력을 되짚어야 알 수 있고
 * 그건 UTxOut 집합을 가진 노드만 할 수 있다. 주소 색인이 블록에 대해
 * 하는 일을 mempool 에 대해 하는 셈이라, 응답 모양도 색인과 맞춘다.
 */
app.get("/me/pending", requireWalletAuth, (req, res) => {
  const mine = new Set(getAddresses());
  const mempool = getMempool();

  // 확정된 출력에 더해 mempool 이 만든 출력도 되짚을 수 있어야 한다
  // (확인을 기다리지 않고 연달아 보낸 경우)
  const sources = indexByOutpoint(getUTxOutList());
  for (const tx of mempool) {
    tx.txOuts.forEach((txOut, index) => {
      sources.set(`${tx.id}:${index}`, txOut);
    });
  }

  const entries = [];
  for (const tx of mempool) {
    let received = 0;
    let spent = 0;
    let inputTotal = 0;

    for (const txIn of tx.txIns) {
      const source = sources.get(`${txIn.txOutId}:${txIn.txOutIndex}`);
      if (source === undefined) {
        continue;
      }
      inputTotal += source.amount;
      if (mine.has(source.address)) {
        spent += source.amount;
      }
    }
    const outputTotal = tx.txOuts.reduce((sum, txOut) => sum + txOut.amount, 0);
    for (const txOut of tx.txOuts) {
      if (mine.has(txOut.address)) {
        received += txOut.amount;
      }
    }

    if (received > 0 || spent > 0) {
      entries.push({
        txId: tx.id,
        blockIndex: null,
        timestamp: null,
        coinbase: false,
        outputTotal,
        received,
        spent,
        fee: Math.max(0, inputTotal - outputTotal)
      });
    }
  }
  res.send(entries);
});

// 받을 주소를 새로 하나 만든다
app.post("/me/address", requireWalletAuth, (req, res) => {
  res.send({ address: getNewAddress() });
});

/*
 * 백업용 니모닉.
 *
 * 이 단어들만 있으면 지갑을 통째로 되살릴 수 있다. 곧 이 응답을 보는
 * 것은 지갑을 보는 것과 같으므로 토큰이 필요하다.
 */
app.get("/me/mnemonic", requireWalletAuth, (req, res) => {
  const mnemonic = getMnemonic();
  if (mnemonic === null) {
    res.status(404).send("이 지갑에는 니모닉이 없습니다(예전 형식으로 만들어진 지갑입니다)");
    return;
  }
  res.send({ mnemonic, words: mnemonic.split(" ").length });
});

/*
 * 니모닉으로 지갑을 되살린다.
 *
 * "어디까지 썼는지"는 니모닉에 들어 있지 않으므로 체인을 훑어 찾는다.
 * 연속으로 GAP_LIMIT 개가 비어 있으면 거기서 멈춘다.
 *
 * 지금 지갑을 덮어쓴다. 되살릴 니모닉이 맞는지 먼저 확인할 것.
 */
app.post("/me/restore", requireWalletAuth, (req, res) => {
  try {
    const { body: { mnemonic } } = req;
    if (typeof mnemonic !== "string" || mnemonic.trim() === "") {
      throw Error('{"mnemonic": "단어 12~24개"} 를 보내세요');
    }
    const found = restoreFromMnemonic(mnemonic, AddressIndexApi.hasAddress);
    res.send({
      ...found,
      gapLimit: GAP_LIMIT,
      balance: getAccountBalance()
    });
  } catch (e) {
    res.status(400).send(e.message);
  }
});

app.get("/blocks/:hash", (req, res) => {
  const { params : { hash } } = req;
  const block = getBlockByHash(hash);
  if(block === undefined){
    res.status(404).send("Block not found")
  }else{
    res.send(block);
  }
});

/*
 * 트랜잭션 하나.
 *
 * 아직 블록에 담기지 않은 것(mempool)도 찾아 준다. 보낸 직후에 열어 볼 수
 * 있어야 하기 때문이다 — 예전에는 체인에 없으면 그냥 "찾을 수 없음"이었다.
 * 담긴 블록이 있으면 높이와 확인 수를 함께 준다.
 */
app.get("/transactions/:id", (req, res) => {
  const found = findTx(req.params.id);
  if(found === null){
    res.status(404).send("Tx not found")
    return;
  }
  const { tx, block, pending } = found;
  res.send({
    ...tx,
    pending,
    blockIndex: pending ? null : block.index,
    blockHash: pending ? null : block.hash,
    timestamp: pending ? null : block.timestamp,
    confirmations: pending ? 0 : getNewestBlock().index - block.index + 1
  });
});

app.route("/transactions")
  .get((req, res) => {
    res.send(getMempool());
  })
  .post(requireWalletAuth, (req, res) => {
    try {
      const { body: { address, amount, fee = 0 } } = req;
      if (address === undefined || amount === undefined) {
        throw Error("Please specify an address and an amount");
      }
      // amount 와 fee 는 최소 단위(lm) 정수다. 1 LIM = 100,000,000 lm.
      res.send(sendTx(address, amount, fee));
    } catch (e) {
      res.status(400).send(e.message);
    }
  });

/*
 * 백서 8장 "Simplified Payment Verification".
 * 블록 전체를 받지 않고도 트랜잭션이 담겼음을 확인할 수 있는 머클 증명.
 * 검증하는 쪽은 블록 헤더의 merkleRoot 만 있으면 된다.
 */
app.get("/transactions/:id/proof", (req, res) => {
  const proof = getTxProof(req.params.id);
  if (proof === null) {
    res.status(404).send("Tx not found in any block");
  } else {
    res.send(proof);
  }
});

// 자동 채굴 제어
app.route("/mining")
  .get((req, res) => {
    res.send(Miner.getStatus());
  })
  .post(requireWalletAuth, async (req, res) => {
    const { body: { enabled } } = req;
    if (typeof enabled !== "boolean") {
      res.status(400).send('{"enabled": true} 또는 {"enabled": false} 를 보내세요');
      return;
    }
    if (enabled) {
      Miner.start();
    } else {
      await Miner.stop();
    }
    res.send(Miner.getStatus());
  });

/*
 * 검색어가 무엇을 가리키는지 노드가 판별해 준다.
 *
 * 블록 해시와 트랜잭션 id 는 둘 다 64자 16진수라 겉모습으로 가릴 수 없다.
 * 클라이언트가 블록을 먼저 찔러 보고 404 면 트랜잭션으로 넘어가는 식이면
 * 정상 동작인데도 실패한 요청이 남는다. 노드는 둘 다 알고 있으므로
 * 한 번에 답할 수 있다.
 */
app.get("/search/:query", (req, res) => {
  const query = req.params.query;

  if (/^\d+$/.test(query)) {
    const chain = getBlockChain();
    const height = Number(query);
    const block = chain[height];
    if (block === undefined) {
      res.status(404).send(`높이 ${height} 인 블록이 없습니다 (0 ~ ${chain.length - 1})`);
      return;
    }
    res.send({ type: "block", hash: block.hash });
    return;
  }

  if (isAddressValid(query)) {
    res.send({ type: "address", address: query });
    return;
  }

  if (!/^[a-fA-F0-9]{64}$/.test(query)) {
    res.status(400).send("블록 높이, 64자 해시, 또는 04 로 시작하는 주소를 입력하세요");
    return;
  }

  // 색인 조회. 예전에는 블록을, 그다음 트랜잭션 전체를 훑었다.
  const block = getBlockByHash(query);
  if (block !== undefined) {
    res.send({ type: "block", hash: block.hash });
    return;
  }

  if (findTx(query) !== null) {
    res.send({ type: "tx", id: query });
    return;
  }

  res.status(404).send("해당하는 블록이나 트랜잭션이 없습니다");
});

// 화폐 정책과 체인 상태
app.get("/info", (req, res) => {
  const newest = getNewestBlock();
  const nextIndex = newest.index + 1;

  // 익스플로러가 통계를 내려고 체인 전체를 받지 않아도 되게 여기서 계산한다.
  // 수수료는 이미 유통 중이던 코인이 옮겨 간 것이라 발행량이 아니다.
  const mempool = getMempool();
  /*
   * getTxFee 는 배열을 받으면 입력마다 그 배열을 훑는다. mempool 500건에
   * UTxOut 2만 개면 폴링 한 번에 천만 번 비교다. 지갑과 익스플로러가
   * 4초마다 부르는 자리라 색인을 한 번만 만들어 돌려 쓴다.
   */
  const unspent = indexByOutpoint(getUTxOutList());
  const mempoolFees = mempool.reduce(
    (sum, tx) => sum + Math.max(0, getTxFee(tx, unspent)),
    0
  );

  /*
   * 예전에는 체인을 통째로 훑어 트랜잭션 수와 발행량을 셌다. 4초마다
   * 부르는 자리에서 체인 길이에 비례하는 값을 낼 이유가 없다.
   * 트랜잭션 수는 색인이 이미 알고, 발행량은 반감기 구간별로 계산한다.
   */
  const txCount = ChainIndex.getIndexedTxCount();
  const supply = getTotalSupply(newest.index);

  res.send({
    height: newest.index,
    difficulty: newest.difficulty,
    txCount,
    supply,
    mempoolSize: mempool.length,
    // 다음 블록을 채굴하면 채굴자가 가져갈 수수료 합.
    // UTxOut 집합을 가진 노드가 계산하는 게 맞다 — 지갑이 하려면
    // 입력이 가리키는 출력을 되짚으려고 블록을 받아 와야 한다.
    mempoolFees,
    mining: Miner.getStatus().running,
    coin: COIN,
    decimals: DECIMALS,
    initialSubsidy: INITIAL_SUBSIDY,
    halvingInterval: HALVING_INTERVAL,
    currentSubsidy: getBlockSubsidy(nextIndex),
    nextHalvingAtHeight:
      (Math.floor(nextIndex / HALVING_INTERVAL) + 1) * HALVING_INTERVAL,
    maxTxsPerBlock: MAX_TXS_PER_BLOCK,
    coinbaseMaturity: COINBASE_MATURITY,
    indexedAddresses: AddressIndex.getIndexedAddressCount(),
    // 지갑이 기본값으로 쓸 입력당 권장 수수료
    recommendedFeePerInput: Mempool.estimateFee(getUTxOutList(), MAX_TXS_PER_BLOCK - 1).perInput
  });
});

/*
 * 권장 수수료. mempool 이 다음 블록 자리(코인베이스 뺀 99건)보다 비어
 * 있으면 바닥값, 넘치면 담기는 마지막 자리보다 조금 높은 값.
 */
app.get("/fees", (req, res) => {
  res.send(Mempool.estimateFee(getUTxOutList(), MAX_TXS_PER_BLOCK - 1));
});

app.get("/address/:address", (req, res) => {
  const { params : { address } } = req;
  if(!isAddressValid(address)){
    res.status(400).send("Invalid address");
    return;
  }
  const balance = getBalance(address, getUTxOutList());
  res.send({ balance });
});

/*
 * 주소의 트랜잭션 내역.
 *
 * 예전에는 지갑도 익스플로러도 블록을 전부 받아다 각자 훑었다. 그래서
 * 지갑 내역이 "최근 500블록"으로 잘렸고, 같은 계산을 셋이 따로 했다.
 * 노드가 블록을 붙일 때 한 번만 색인해 두면 된다.
 *
 * received / spent 를 그대로 준다. 순수입은 received - spent 이고,
 * 둘 다 0 이 아니면서 차이가 나면 그 차액이 수수료를 포함한 실제 지출이다.
 */
app.get("/address/:address/transactions", (req, res) => {
  const { params : { address } } = req;
  if (!isAddressValid(address)) {
    res.status(400).send("Invalid address");
    return;
  }
  const limit = clampInt(req.query.limit, DEFAULT_PAGE, MAX_PAGE);
  const offset = clampInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
  const { total, transactions } = AddressIndex.getTransactions(address, limit, offset);
  res.set("X-Total-Count", String(total));
  res.send(transactions);
});

// 주소가 가진 미사용 출력. 지갑이 직접 코인을 고를 때 쓴다.
app.get("/address/:address/utxos", (req, res) => {
  const { params : { address } } = req;
  if (!isAddressValid(address)) {
    res.status(400).send("Invalid address");
    return;
  }
  res.send(getUTxOutList().filter(uTxOut => uTxOut.address === address));
});

// HTTP + P2P 서버를 띄운다. 포트를 넘기면 그 포트를 쓴다(Electron 지갑용).
const start = (port = PORT, options = {}) => {
  initWallet();

  // 저장된 체인을 읽어 이어서 시작한다
  const { restored, height } = initChain(options.dataDir);
  if (restored > 0) {
    console.log(`저장된 체인을 복원했습니다: 블록 ${restored}개 (높이 ${height})`);
  }

  const server = app.listen(port, () =>
    console.log("LimCoin Server running ON", port)
  );
  startP2PServer(server);

  /*
   * 남이 나에게 걸 수 있는 주소. 피어에게 알려 주어 그들이 우리에게 붙거나
   * 다른 피어에게 우리를 소개할 수 있게 한다.
   *   LIMCOIN_PUBLIC_URL=ws://203.0.113.5:3000
   * 없으면 남의 주소를 배우기만 하고 우리를 알리지는 못한다.
   */
  const publicUrl = options.publicUrl || process.env.LIMCOIN_PUBLIC_URL;
  if (publicUrl) {
    try {
      setPublicUrl(publicUrl);
    } catch (e) {
      console.log(`LIMCOIN_PUBLIC_URL 이 올바르지 않습니다: ${e.message}`);
    }
  }

  if (AUTH_DISABLED) {
    console.log("경고: 지갑 인증이 꺼져 있습니다. 이 포트에 닿는 누구나 송금할 수 있습니다.");
  } else if (!process.env.LIMCOIN_WALLET_TOKEN) {
    console.log(`지갑 토큰: ${WALLET_TOKEN}`);
    console.log("  사용: curl -H 'Authorization: Bearer <토큰>' ...");
  }

  if (process.env.LIMCOIN_MINE === "1" || options.mine) {
    Miner.start();
  }

  /*
   * 뜰 때 붙을 피어들. 쉼표로 여러 개.
   *   LIMCOIN_PEERS=ws://a:3000,ws://b:3000
   * 붙지 못하면 간격을 늘리며 계속 다시 건다 — 상대가 나중에 떠도 된다.
   */
  const peers = (options.peers || process.env.LIMCOIN_PEERS || "")
    .split(",")
    .map(peer => peer.trim())
    .filter(peer => peer !== "");
  for (const peer of peers) {
    try {
      connectToPeers(peer);
    } catch (e) {
      console.log(`피어 ${peer} 에 붙지 못합니다: ${e.message}`);
    }
  }

  return server;
};

/*
 * 종료할 때 mempool 을 남긴다.
 *
 * 아직 블록에 담기지 않은 트랜잭션은 메모리에만 있다. 그냥 죽으면
 * 보낸 사람은 영문도 모른 채 다시 보내야 한다. 채굴 워커도 함께
 * 정리해야 프로세스가 매달리지 않는다.
 *
 * kill -9 는 어쩔 수 없다 — 비트코인 코어도 마찬가지다.
 */
let shuttingDown = false;
const shutdown = async signal => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n${signal} 를 받았습니다. 정리하고 종료합니다.`);
  try {
    await Miner.stop();
    persistMempool();
  } catch (e) {
    console.log(`종료 정리 중 문제가 있었습니다: ${e.message}`);
  }
  process.exit(0);
};

// `node src/server.js` 로 직접 실행할 때만 자동으로 띄운다.
if (require.main === module) {
  start();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => shutdown(signal));
  }
}

module.exports = { app, start, shutdown, connectToPeers, WALLET_TOKEN };
