const express = require("express"),
    bodyParser = require("body-parser"),
    morgan = require("morgan"),
    Blockchain = require("./blockchain");

const { getBlockChain, createNewBlock } = Blockchain;

const PORT = 3000;

const app = express();
app.use(bodyParser.json());
app.use(morgan("combined"));
app.listen(PORT, () => console.log('LimCoin Server running ON', PORT));
