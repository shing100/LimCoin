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
    crypto = require("crypto"),
    _ = require("lodash");

const { getBlockChain, createNewBlock, getAccountBalance, sendTx, getUTxOutList, getTxProof, getNewestBlock, initChain } = Blockchain;
const { startP2PServer, connectToPeers, getPeers } = P2P;
const { initWallet, getPublicFromWallet, getBalance } = Wallet;
const { getMempool } = Mempool;
const { isAddressValid, getBlockSubsidy, HALVING_INTERVAL, INITIAL_SUBSIDY, MAX_TXS_PER_BLOCK } = Transactions;
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

// 읽기 전용 엔드포인트만 교차 출처를 허용한다
// X-Total-Count 는 단순 응답 헤더가 아니라서, 명시적으로 노출하지 않으면
// 교차 출처에서 읽을 수 없다. 익스플로러의 페이지네이션이 이 값에 기댄다.
const publicCors = cors({ exposedHeaders: ["X-Total-Count"] });
const readOnly = ["/blocks", "/transactions", "/peers", "/address", "/info", "/search"];
app.use((req, res, next) => {
  if (readOnly.some(prefix => req.path.startsWith(prefix)) && req.method === "GET") {
    return publicCors(req, res, next);
  }
  next();
});

// 지갑을 건드리는 요청은 토큰을 요구한다
const requireWalletAuth = (req, res, next) => {
  if (AUTH_DISABLED) {
    return next();
  }
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.get("X-Wallet-Token");
  if (token !== WALLET_TOKEN) {
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
  // 최신 블록이 앞으로 오게 뒤집어 잘라 준다
  const page = chain.slice().reverse().slice(offset, offset + limit);
  res.set("X-Total-Count", String(chain.length));
  res.send(page);
}).post(requireWalletAuth, async (req, res) => {
  try {
    res.send(await createNewBlock());
  } catch (e) {
    res.status(400).send(e.message);
  }
});

app.route("/peers")
  .get((req, res) => {
    res.send(getPeers());
  })
  .post((req, res) => {
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
  });

app.get("/me/balance", requireWalletAuth, (req, res) => {
  const balance = getAccountBalance();
  res.send({ balance });
});

app.get("/me/address", requireWalletAuth, (req,res) => {
  res.send(getPublicFromWallet());
});

app.get("/blocks/:hash", (req, res) => {
  const { params : { hash } } = req;
  const block = _.find(getBlockChain(), { hash });
  if(block === undefined){
    res.status(400).send("Block not found")
  }else{
    res.send(block);
  }
});

app.get("/transactions/:id", (req, res) => {
  const tx = _(getBlockChain()).map(blocks => blocks.data).flatten().find({ id: req.params.id });
  if(tx === undefined){
    res.status(400).send("Tx not found")
  }else{
    res.send(tx);
  }
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

  const block = _.find(getBlockChain(), { hash: query });
  if (block !== undefined) {
    res.send({ type: "block", hash: block.hash });
    return;
  }

  const tx = _(getBlockChain()).map(b => b.data).flatten().find({ id: query });
  if (tx !== undefined) {
    res.send({ type: "tx", id: tx.id });
    return;
  }

  res.status(404).send("해당하는 블록이나 트랜잭션이 없습니다");
});

// 화폐 정책과 체인 상태
app.get("/info", (req, res) => {
  const chain = getBlockChain();
  const newest = getNewestBlock();
  const nextIndex = newest.index + 1;

  // 익스플로러가 통계를 내려고 체인 전체를 받지 않아도 되게 여기서 계산한다.
  // 수수료는 이미 유통 중이던 코인이 옮겨 간 것이라 발행량이 아니다.
  let txCount = 0;
  let supply = 0;
  for (const block of chain) {
    const txs = block.data || [];
    txCount += txs.length;
    supply += getBlockSubsidy(block.index);
  }

  res.send({
    height: newest.index,
    difficulty: newest.difficulty,
    txCount,
    supply,
    mempoolSize: getMempool().length,
    mining: Miner.getStatus().running,
    coin: COIN,
    decimals: DECIMALS,
    initialSubsidy: INITIAL_SUBSIDY,
    halvingInterval: HALVING_INTERVAL,
    currentSubsidy: getBlockSubsidy(nextIndex),
    nextHalvingAtHeight:
      (Math.floor(nextIndex / HALVING_INTERVAL) + 1) * HALVING_INTERVAL,
    maxTxsPerBlock: MAX_TXS_PER_BLOCK
  });
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

  if (AUTH_DISABLED) {
    console.log("경고: 지갑 인증이 꺼져 있습니다. 이 포트에 닿는 누구나 송금할 수 있습니다.");
  } else if (!process.env.LIMCOIN_WALLET_TOKEN) {
    console.log(`지갑 토큰: ${WALLET_TOKEN}`);
    console.log("  사용: curl -H 'Authorization: Bearer <토큰>' ...");
  }

  if (process.env.LIMCOIN_MINE === "1" || options.mine) {
    Miner.start();
  }

  return server;
};

// `node src/server.js` 로 직접 실행할 때만 자동으로 띄운다.
if (require.main === module) {
  start();
}

module.exports = { app, start, connectToPeers, WALLET_TOKEN };
