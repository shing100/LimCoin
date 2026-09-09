/**
 * 비트코인 호환 JSON-RPC.
 *
 * 여기서 보는 것은 "거래소 도구가 기대하는 모양대로 답하는가"이다.
 * 값이 맞는지(잔액, 수수료)는 다른 테스트가 이미 본다. 이 파일은 껍데기가
 * 제 모양인지, 오류 코드가 저쪽 관례와 같은지, params 를 배열로도 객체로도
 * 받는지, 배치가 도는지를 본다.
 */
process.env.LIMCOIN_NETWORK = "regtest";
process.env.LIMCOIN_WALLET = "off"; // 지갑 메서드는 토큰 거절만 본다

const test = require("node:test");
const assert = require("node:assert");

const Rpc = require("../src/rpc");
const Blockchain = require("../src/blockchain");
const Mempool = require("../src/memPool");
const S = require("../src/serialization");
const Keys = require("../src/keys");
const Address = require("../src/address");
const Params = require("../src/params");
const Target = require("../src/target");
const Script = require("../src/script");
const { createCoinbaseTx, getTxId, getBlockSubsidy } = require("../src/transactions");
const { formatLim } = require("../src/units");
const { mineOnto, timestampFor } = require("./helpers");

const version = Params.current().addressVersion;
const key = Keys.generatePrivateKey();
const pub = Keys.getPublicKey(key);
const addr = Address.addressFromPublicKey(pub, version);

/* 코인베이스만 든 블록 세 개를 우리 주소로 채굴해 체인을 세운다 */
const genesis = Blockchain.getBlockChain()[0];
const chain = [genesis];
for (let i = 0; i < 3; i++) {
  const tip = chain[chain.length - 1];
  const timestamp = timestampFor(tip, i * 10);
  const bits = Blockchain.bitsForNext(chain, timestamp);
  chain.push(mineOnto(tip, [createCoinbaseTx(addr, tip.index + 1, 0)], i * 10, bits));
}
assert.strictEqual(Blockchain.replaceChain(chain), true, "테스트 체인이 서야 한다");

const tip = Blockchain.getNewestBlock();
const coinbase = Blockchain.getBlockByHeight(1).data[0];

// 오류 없이 결과만 꺼낸다
const rpc = (method, params, authorized = false) => {
  const answer = Rpc.call({ jsonrpc: "2.0", id: 7, method, params }, authorized);
  assert.strictEqual(answer.id, 7);
  assert.strictEqual(answer.error, null, `${method}: ${answer.error && answer.error.message}`);
  return answer.result;
};

// 오류 코드만 꺼낸다
const rpcError = (method, params, authorized = false) => {
  const answer = Rpc.call({ jsonrpc: "2.0", id: 1, method, params }, authorized);
  assert.notStrictEqual(answer.error, null, `${method} 는 실패해야 한다`);
  assert.strictEqual(answer.result, null);
  return answer.error.code;
};

/* ------------------------------------------- 체인 조회 */

test("getblockcount / getbestblockhash / getblockhash 는 팁을 가리킨다", () => {
  assert.strictEqual(rpc("getblockcount"), tip.index);
  assert.strictEqual(rpc("getbestblockhash"), tip.hash);
  assert.strictEqual(rpc("getblockhash", [tip.index]), tip.hash);
  assert.strictEqual(rpc("getblockhash", [0]), genesis.hash);

  // 비트코인의 코드를 그대로 쓴다
  assert.strictEqual(rpcError("getblockhash", [tip.index + 100]), -8);
  assert.strictEqual(rpcError("getblockhash", [-1]), -8);
  assert.strictEqual(rpcError("getblockhash", ["첫째"]), -8);
});

test("getblock 은 verbosity 0/1/2 를 구분한다", () => {
  const raw = rpc("getblock", [tip.hash, 0]);
  assert.match(raw, /^[0-9a-f]+$/);
  assert.strictEqual(S.decodeBlock(raw).hash, tip.hash, "0 이면 raw hex 다");

  const one = rpc("getblock", [tip.hash, 1]);
  assert.strictEqual(one.hash, tip.hash);
  assert.strictEqual(one.height, tip.index);
  assert.strictEqual(one.confirmations, 1);
  assert.strictEqual(one.previousblockhash, tip.previousHash);
  assert.strictEqual(one.merkleroot, tip.merkleRoot);
  assert.strictEqual(one.nTx, tip.data.length);
  assert.deepStrictEqual(one.tx, tip.data.map(t => t.id), "1 이면 id 목록이다");
  assert.strictEqual(one.difficulty, Target.difficultyOf(tip.bits));
  assert.strictEqual(typeof one.chainwork, "string");

  const two = rpc("getblock", [tip.hash, 2]);
  assert.strictEqual(two.tx[0].txid, tip.data[0].id, "2 면 트랜잭션 객체다");
  assert.strictEqual(typeof two.tx[0].vout[0].value, "number");

  // 옛 도구는 boolean 을 준다
  assert.deepStrictEqual(rpc("getblock", [tip.hash, true]).tx, one.tx);
  assert.strictEqual(rpc("getblock", [tip.hash, false]), raw);

  assert.strictEqual(rpcError("getblock", ["00".repeat(32)]), -5);
  assert.strictEqual(rpcError("getblock", ["짧다"]), -5);
});

test("getblockheader 는 verbose 아니면 88바이트 헤더다", () => {
  const hex = rpc("getblockheader", [tip.hash, false]);
  assert.strictEqual(hex.length, 88 * 2, "우리 헤더는 88바이트다");
  assert.strictEqual(hex, S.serializeHeader(tip).toString("hex"));

  const header = rpc("getblockheader", [tip.hash]);
  assert.strictEqual(header.hash, tip.hash);
  assert.strictEqual(header.height, tip.index);
  assert.strictEqual(header.tx, undefined, "헤더에는 트랜잭션 목록이 없다");
  assert.strictEqual(header.nTx, tip.data.length, "개수만 알린다 (비트코인과 같다)");
});

test("getblockchaininfo / getdifficulty / getchaintips", () => {
  const info = rpc("getblockchaininfo");
  assert.strictEqual(info.chain, "regtest");
  assert.strictEqual(info.blocks, tip.index);
  assert.strictEqual(info.headers, tip.index);
  assert.strictEqual(info.bestblockhash, tip.hash);
  assert.strictEqual(info.difficulty, Target.difficultyOf(tip.bits));
  assert.strictEqual(typeof info.chainwork, "string");
  assert.strictEqual(info.initialblockdownload, false);

  assert.strictEqual(rpc("getdifficulty"), Target.difficultyOf(tip.bits));

  const tips = rpc("getchaintips");
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].hash, tip.hash);
  assert.strictEqual(tips[0].status, "active");
});

/* ------------------------------------------- 트랜잭션 */

test("getrawtransaction 은 hex 도 주고 풀어서도 준다", () => {
  const raw = rpc("getrawtransaction", [coinbase.id]);
  assert.strictEqual(raw, S.encodeTx(coinbase));

  const verbose = rpc("getrawtransaction", [coinbase.id, true]);
  assert.strictEqual(verbose.txid, coinbase.id);
  assert.strictEqual(verbose.blockhash, Blockchain.getBlockByHeight(1).hash);
  assert.strictEqual(verbose.blockheight, 1);
  assert.strictEqual(verbose.confirmations, tip.index, "1번 블록이니 팁 높이만큼 쌓였다");
  assert.strictEqual(verbose.in_active_chain, true);
  assert.strictEqual(verbose.hex, raw);
  assert.ok(verbose.vin[0].coinbase !== undefined, "코인베이스는 vin 이 특별하다");
  assert.strictEqual(verbose.vout[0].scriptPubKey.address, addr);
  assert.strictEqual(verbose.vout[0].n, 0);

  assert.strictEqual(rpcError("getrawtransaction", ["ab".repeat(32)]), -5);
});

test("decoderawtransaction 은 우리가 만든 hex 를 그대로 읽는다", () => {
  const spend = {
    txIns: [{ txOutId: coinbase.id, txOutIndex: 0, signature: "" }],
    txOuts: [{ address: addr, amount: 1000 }],
    lockTime: 0
  };
  spend.id = getTxId(spend);
  spend.txIns[0].signature = Keys.sign(key, spend.id);
  spend.txIns[0].publicKey = pub;

  const decoded = rpc("decoderawtransaction", [S.encodeTx(spend)]);
  assert.strictEqual(decoded.txid, spend.id);
  assert.strictEqual(decoded.vin[0].txid, coinbase.id);
  assert.strictEqual(decoded.vin[0].vout, 0);
  assert.strictEqual(decoded.vout[0].value, 0.00001);
  assert.strictEqual(decoded.locktime, 0);

  assert.strictEqual(rpcError("decoderawtransaction", ["ffff"]), -8);
  assert.strictEqual(rpcError("decoderawtransaction", ["지긋지긋"]), -8);
});

test("sendrawtransaction 은 거절 사유마다 다른 코드를 준다", () => {
  assert.strictEqual(rpcError("sendrawtransaction", ["00"]), -8, "읽을 수 없으면 -8");

  // 이미 체인에 있는 것
  assert.strictEqual(
    rpcError("sendrawtransaction", [S.encodeTx(coinbase)]),
    -27,
    "이미 아는 것이면 -27"
  );

  // 서명이 틀린 것 — 규칙에 걸린다
  const bad = {
    txIns: [{ txOutId: coinbase.id, txOutIndex: 0, signature: "", publicKey: pub }],
    txOuts: [{ address: addr, amount: 1000 }],
    lockTime: 0
  };
  bad.id = getTxId(bad);
  bad.txIns[0].signature = Keys.sign(Keys.generatePrivateKey(), bad.id); // 남의 키
  assert.strictEqual(rpcError("sendrawtransaction", [S.encodeTx(bad)]), -26, "규칙 위반이면 -26");
  assert.strictEqual(Mempool.getMempool().length, 0, "거절된 것은 남지 않는다");
});

test("gettxout 은 안 쓴 출력만 준다", () => {
  const out = rpc("gettxout", [coinbase.id, 0]);
  assert.strictEqual(out.value, Number(formatLim(getBlockSubsidy(1))));
  assert.strictEqual(out.coinbase, true);
  assert.strictEqual(out.confirmations, tip.index);
  assert.strictEqual(out.bestblock, tip.hash);
  assert.strictEqual(out.scriptPubKey.address, addr);
  assert.strictEqual(out.scriptPubKey.type, "pubkeyhash");

  assert.strictEqual(rpc("gettxout", [coinbase.id, 9]), null, "없는 자리는 null");
  assert.strictEqual(rpc("gettxout", ["ab".repeat(32), 0]), null, "모르는 tx 도 null");
});

test("validateaddress 는 세 형식을 구분한다", () => {
  const ok = rpc("validateaddress", [addr]);
  assert.strictEqual(ok.isvalid, true);
  assert.strictEqual(ok.address, addr);
  assert.strictEqual(ok.isscript, false);
  assert.strictEqual(ok.type, "pubkeyhash");
  assert.strictEqual(ok.iswitness, false);

  const redeem = Script.multisig(1, [pub]);
  const p2sh = Address.addressFromScript(redeem, Params.current().scriptAddressVersion);
  const script = rpc("validateaddress", [p2sh]);
  assert.strictEqual(script.isvalid, true);
  assert.strictEqual(script.isscript, true);
  assert.strictEqual(script.type, "scripthash");

  assert.deepStrictEqual(rpc("validateaddress", ["없는주소"]), { isvalid: false });
  assert.deepStrictEqual(rpc("validateaddress", [addr.slice(0, -1) + "x"]), { isvalid: false });
  assert.deepStrictEqual(rpc("validateaddress", [42]), { isvalid: false });
});

/* ------------------------------------------- mempool·수수료·망 */

test("getrawmempool / getmempoolinfo / estimatesmartfee", () => {
  assert.deepStrictEqual(rpc("getrawmempool"), [], "비어 있으면 빈 배열");
  assert.deepStrictEqual(rpc("getrawmempool", [true]), {}, "verbose 면 빈 객체");

  const info = rpc("getmempoolinfo");
  assert.strictEqual(info.size, 0);
  assert.strictEqual(info.loaded, true);
  assert.ok(info.maxmempool > 0);
  assert.ok(info.mempoolminfee > 0, "kB 당 최소 수수료가 LIM 소수로 온다");

  const fee = rpc("estimatesmartfee", [6]);
  assert.strictEqual(fee.blocks, 6);
  assert.ok(fee.feerate > 0);
  assert.strictEqual(rpc("estimatesmartfee", []).blocks, 1, "안 주면 1");
});

test("getnetworkinfo 는 우리 것(노드 신원·암호화)도 같이 알린다", () => {
  const net = rpc("getnetworkinfo");
  assert.match(net.subversion, /^\/LimCoin:/);
  assert.strictEqual(net.networkactive, true);
  assert.ok(net.relayfee > 0);
  assert.strictEqual(typeof net.nodeid, "string");
  assert.ok(["optional", "required", "off"].includes(net.encryption));

  assert.strictEqual(rpc("getconnectioncount"), 0);
  assert.deepStrictEqual(rpc("getpeerinfo"), []);
  assert.ok(rpc("uptime") >= 0);
});

/* ------------------------------------------- 규약 */

test("params 는 배열로도 이름 붙인 객체로도 받는다", () => {
  assert.strictEqual(
    rpc("getblockhash", { height: 1 }),
    rpc("getblockhash", [1]),
    "비트코인 코어처럼 named params 를 받는다"
  );
  const named = rpc("getblock", { blockhash: tip.hash, verbosity: 2 });
  assert.strictEqual(named.tx[0].txid, tip.data[0].id);
  assert.strictEqual(rpcError("getblockhash", "높이"), -32602);
});

test("모르는 메서드와 망가진 요청은 JSON-RPC 코드로 답한다", () => {
  assert.strictEqual(rpcError("없는메서드"), -32601);
  assert.strictEqual(Rpc.call("문자열", true).error.code, -32600);
  assert.strictEqual(Rpc.call(null, true).error.code, -32600);
  assert.strictEqual(Rpc.call({ id: 3 }, true).error.code, -32600, "method 가 없다");
  assert.strictEqual(Rpc.call([], true).error.code, -32600, "빈 배치");

  // id 는 그대로 돌려준다 — 짝을 맞추는 데 쓴다
  assert.strictEqual(Rpc.call({ method: "getblockcount", id: "abc" }, false).id, "abc");
  assert.strictEqual(Rpc.call({ method: "getblockcount" }, false).id, null);
});

test("배치 요청은 순서대로 같은 개수를 돌려준다", () => {
  const answers = Rpc.call(
    [
      { jsonrpc: "2.0", id: 1, method: "getblockcount" },
      { jsonrpc: "2.0", id: 2, method: "없는메서드" },
      { jsonrpc: "2.0", id: 3, method: "getblockhash", params: [0] }
    ],
    false
  );
  assert.strictEqual(answers.length, 3);
  assert.deepStrictEqual(answers.map(a => a.id), [1, 2, 3]);
  assert.strictEqual(answers[0].result, tip.index);
  assert.strictEqual(answers[1].error.code, -32601);
  assert.strictEqual(answers[2].result, genesis.hash);
});

test("지갑 메서드는 토큰 없이는 -4 로 막힌다", () => {
  const walletMethods = Object.keys(Rpc.methods).filter(name => Rpc.methods[name].wallet);
  assert.ok(walletMethods.length >= 8, "지갑 메서드가 있어야 한다");
  for (const name of walletMethods) {
    assert.strictEqual(rpcError(name, []), -4, `${name} 는 토큰이 필요하다`);
  }

  // 조회 메서드는 토큰 없이 된다
  assert.strictEqual(Rpc.needsWallet({ method: "getblockcount" }), false);
  assert.strictEqual(Rpc.needsWallet({ method: "sendtoaddress" }), true);
  assert.strictEqual(
    Rpc.needsWallet([{ method: "getblockcount" }, { method: "getbalance" }]),
    true,
    "배치에 하나라도 섞이면 토큰이 필요하다"
  );
  assert.strictEqual(Rpc.needsWallet({ method: "없는메서드" }), false);
});

test("help 는 등록된 메서드를 모두 적는다", () => {
  const help = rpc("help");
  for (const name of Object.keys(Rpc.methods)) {
    assert.ok(help.includes(name), `help 에 ${name} 가 없다`);
  }
});
