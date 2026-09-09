/**
 * 지갑 RPC — 거래소가 실제로 부르는 것들.
 *
 * 여기 있는 셋은 전부 "인자를 받기만 하고 버리던" 자리였다. 조용히 버리는
 * 쪽이 더 위험한 방향이라서 따로 본다.
 *
 *   listunspent(minconf, maxconf, addresses)
 *     — 주소를 줬는데 무시하면 지갑 전체를 돌려준다. 받는 쪽은 남의 출력을
 *       그 주소 몫으로 센다.
 *   walletpassphrase(passphrase, timeout)
 *     — timeout 을 무시하면 부른 쪽은 잠긴 줄 알지만 지갑은 열려 있다.
 *   getwalletinfo
 *     — txcount 가 지갑 것이 아닌 값이었고 unconfirmed_balance 는 0 고정이었다.
 */
process.env.LIMCOIN_NETWORK = "regtest";

const fs = require("fs");
const os = require("os");
const path = require("path");

// 지갑 파일은 임시 자리에 — 소스 디렉터리를 건드리면 안 된다
const walletFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "limcoin-rpcwallet-")),
  "wallet.json"
);
process.env.LIMCOIN_WALLET_FILE = walletFile;

const test = require("node:test");
const assert = require("node:assert");

const Rpc = require("../src/rpc");
const Wallet = require("../src/wallet");
const Blockchain = require("../src/blockchain");
const { createCoinbaseTx } = require("../src/transactions");
const { mineOnto, timestampFor } = require("./helpers");

// 지갑 주소로 몇 블록 채굴해 쓸 수 있는 출력을 만든다
const mineTo = (address, count) => {
  const chain = Blockchain.getBlockChain().slice();
  for (let i = 0; i < count; i++) {
    const tip = chain[chain.length - 1];
    const timestamp = timestampFor(tip, i * 10);
    chain.push(
      mineOnto(tip, [createCoinbaseTx(address, tip.index + 1, 0)], i * 10, Blockchain.bitsForNext(chain, timestamp))
    );
  }
  assert.strictEqual(Blockchain.replaceChain(chain), true, "테스트 체인이 서야 한다");
};

Wallet.initWallet(); // 씨앗을 만들어 파일을 쓴다
const first = Wallet.getNewAddress();
const second = Wallet.getNewAddress();
// 코인베이스 성숙도(10)를 넘겨야 쓸 수 있는 것이 생긴다
mineTo(first, 8);
mineTo(second, 8);

const rpc = (method, params) => {
  const answer = Rpc.call({ jsonrpc: "2.0", id: 1, method, params }, true);
  assert.strictEqual(answer.error, null, `${method}: ${answer.error && answer.error.message}`);
  return answer.result;
};
const rpcError = (method, params) => {
  const answer = Rpc.call({ jsonrpc: "2.0", id: 1, method, params }, true);
  assert.notStrictEqual(answer.error, null, `${method} 는 실패해야 한다`);
  return answer.error.code;
};

test("listunspent 는 addresses 를 실제로 좁힌다", () => {
  const all = rpc("listunspent", [1]);
  assert.ok(all.length > 0, "출력이 있어야 한다");
  const addresses = new Set(all.map(u => u.address));
  assert.ok(addresses.has(first) && addresses.has(second), "두 주소 모두 있어야 한다");

  const onlyFirst = rpc("listunspent", [1, 9999999, [first]]);
  assert.ok(onlyFirst.length > 0);
  assert.ok(onlyFirst.every(u => u.address === first), "준 주소 것만 와야 한다");
  assert.ok(onlyFirst.length < all.length, "전체보다 적어야 한다 — 무시하면 같아진다");

  // 내 것이 아닌 주소를 물으면 빈 목록이 맞다 (지갑 전체가 아니라)
  assert.deepStrictEqual(rpc("listunspent", [1, 9999999, ["Lnope"]]), []);
  assert.deepStrictEqual(rpc("listunspent", [1, 9999999, []]), []);

  assert.strictEqual(rpcError("listunspent", [1, 9999999, "주소하나"]), -3, "배열이 아니면 -3");
});

test("listunspent 는 maxconf 로 위쪽도 자른다", () => {
  const all = rpc("listunspent", [1]);
  const deep = Math.max(...all.map(u => u.confirmations));
  assert.ok(deep > 2, `가장 깊은 것이 ${deep}확인`);

  const shallow = rpc("listunspent", [1, 2]);
  assert.ok(shallow.every(u => u.confirmations <= 2), "전부 2확인 이하");
  assert.ok(shallow.length < all.length, "maxconf 가 실제로 걸러야 한다");

  // 이름 인자로도 같아야 한다
  assert.strictEqual(rpc("listunspent", { minconf: 1, maxconf: 2 }).length, shallow.length);

  // minconf 가 깊이보다 크면 빈 목록
  assert.deepStrictEqual(rpc("listunspent", [deep + 1]), []);
});

test("getwalletinfo 의 txcount 는 이 지갑의 트랜잭션 수다", () => {
  const info = rpc("getwalletinfo");
  const mine = rpc("listunspent", [1]);
  assert.ok(info.txcount > 0, `txcount ${info.txcount}`);
  assert.strictEqual(info.keypoolsize, Wallet.getAddresses().length);
  assert.ok(info.balance > 0);
  assert.strictEqual(typeof info.unconfirmed_balance, "number");
  assert.ok(info.txcount >= mine.length, "쓸 수 있는 출력 수 이상이어야 한다");
  assert.strictEqual(info.encrypted, false);
  assert.strictEqual(info.unlocked, true);
});

test("walletpassphrase 는 timeout 뒤에 스스로 잠근다", async () => {
  Wallet.setPassphrase("rpc wallet test");
  assert.strictEqual(Wallet.isEncrypted(), true);
  rpc("walletlock");
  assert.strictEqual(Wallet.isLocked(), true);
  assert.strictEqual(rpcError("getnewaddress", []), -13, "잠기면 -13");

  assert.strictEqual(rpcError("walletpassphrase", ["rpc wallet test", 0]), -8, "timeout 0");
  assert.strictEqual(rpcError("walletpassphrase", ["rpc wallet test", -5]), -8, "음수 timeout");
  assert.strictEqual(rpcError("walletpassphrase", ["rpc wallet test", 1.5]), -8, "정수가 아닌 timeout");
  assert.strictEqual(rpcError("walletpassphrase", ["틀린 암호"]), -4, "암호가 틀리면 -4");

  rpc("walletpassphrase", ["rpc wallet test", 1]);
  assert.strictEqual(Wallet.isLocked(), false, "풀렸어야 한다");

  await new Promise(resolve => {
    setTimeout(resolve, 1300);
  });
  assert.strictEqual(Wallet.isLocked(), true, "1초 뒤 스스로 잠겼어야 한다");
  assert.strictEqual(rpcError("getnewaddress", []), -13);

  // timeout 없이 풀면 계속 열려 있다
  rpc("walletpassphrase", ["rpc wallet test"]);
  assert.strictEqual(Wallet.isLocked(), false);
  await new Promise(resolve => {
    setTimeout(resolve, 1300);
  });
  assert.strictEqual(Wallet.isLocked(), false, "timeout 을 안 줬으면 안 잠긴다");

  // walletlock 은 예약된 잠금도 걷어 간다 — 다시 풀었을 때 엉뚱하게 잠기면 안 된다
  rpc("walletpassphrase", ["rpc wallet test", 1]);
  rpc("walletlock");
  rpc("walletpassphrase", ["rpc wallet test"]);
  await new Promise(resolve => {
    setTimeout(resolve, 1300);
  });
  assert.strictEqual(Wallet.isLocked(), false, "걷어 간 타이머가 살아나면 안 된다");

  Wallet.setPassphrase("");
});

test("listtransactions 는 count/skip 을 검사한다", () => {
  assert.ok(Array.isArray(rpc("listtransactions", ["*", 3, 0])));
  assert.ok(rpc("listtransactions", ["*", 3, 0]).length <= 3);
  assert.strictEqual(rpcError("listtransactions", ["*", -1, 0]), -8);
  assert.strictEqual(rpcError("listtransactions", ["*", "셋", 0]), -8);
  assert.strictEqual(rpcError("listtransactions", ["*", 3, -1]), -8);
});

test.after(() => {
  fs.rmSync(path.dirname(walletFile), { recursive: true, force: true });
});
