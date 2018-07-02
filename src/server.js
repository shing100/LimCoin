const express = require("express"),
    bodyParser = require("body-parser"),
    cors = require("cors"),
    morgan = require("morgan"),
    Blockchain = require("./blockchain"),
    Mempool = require("./mempool"),
    P2P = require("./p2p"),
    Wallet = require("./wallet"),
    _ = require("lodash");

const { getBlockChain, createNewBlock, getAccountBalance, sendTx, getUTxOutList } = Blockchain;
const { startP2PServer, connectToPeers } = P2P;
const { initWallet, getPublicFromWallet, getBalance } = Wallet;
const { getMempool } = Mempool;

const PORT = process.env.HTTP_PORT || 3000;

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(morgan("combined"));

app.route("/blocks").get((req, res) => {
  res.send(getBlockChain());
}).post((req, res) => {
  const newBlock = createNewBlock();
  res.send(newBlock);
});

app.post("/peers", (req, res) => {
  const { body: { peer }} = req;
  connectToPeers(peer);
  res.send();
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
      const { body: { address, amount } } = req;
      if (address === undefined || amount === undefined) {
        throw Error("Please specify and address and an amount");
      } else {
        const resPonse = sendTx(address, amount);
        res.send(resPonse);
      }
    } catch (e) {
      res.status(400).send(e.message);
    }
  });

app.get("/address/:address", (req, res) => {
  const { params : { address } } = req;
  const balance = getBalance(address, getUTxOutList());
  if(balance === undefined){
    res.status(400).send("Address not found")
  }else{
    res.send({balance});
  }
});

const server = app.listen(PORT, () => console.log('LimCoin Server running ON', PORT));

initWallet();
startP2PServer(server);
