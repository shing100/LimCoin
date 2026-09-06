const express = require("express"),
    bodyParser = require("body-parser"),
    cors = require("cors"),
    morgan = require("morgan"),
    Blockchain = require("./blockchain"),
    Mempool = require("./memPool"),
    P2P = require("./p2p"),
    Wallet = require("./wallet"),
    Transactions = require("./transactions"),
    _ = require("lodash");

const { getBlockChain, createNewBlock, getAccountBalance, sendTx, getUTxOutList, getTxProof, getNewestBlock } = Blockchain;
const { startP2PServer, connectToPeers, getPeers } = P2P;
const { initWallet, getPublicFromWallet, getBalance } = Wallet;
const { getMempool } = Mempool;
const { isAddressValid, getBlockSubsidy, HALVING_INTERVAL, INITIAL_SUBSIDY, MAX_TXS_PER_BLOCK } = Transactions;
const { COIN, DECIMALS } = require("./units");

const PORT = process.env.HTTP_PORT || 3000;

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(morgan("combined"));

app.route("/blocks").get((req, res) => {
  res.send(getBlockChain());
}).post((req, res) => {
  try {
    const newBlock = createNewBlock();
    res.send(newBlock);
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

app.get("/me/balance", (req, res) => {
  const balance = getAccountBalance();
  res.send({ balance });
});

app.get("/me/address", (req,res) => {
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
  .post((req, res) => {
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

// 화폐 정책과 체인 상태
app.get("/info", (req, res) => {
  const newest = getNewestBlock();
  const nextIndex = newest.index + 1;
  res.send({
    height: newest.index,
    difficulty: newest.difficulty,
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
const start = (port = PORT) => {
  initWallet();
  const server = app.listen(port, () =>
    console.log("LimCoin Server running ON", port)
  );
  startP2PServer(server);
  return server;
};

// `node src/server.js` 로 직접 실행할 때만 자동으로 띄운다.
if (require.main === module) {
  start();
}

module.exports = { app, start, connectToPeers };
