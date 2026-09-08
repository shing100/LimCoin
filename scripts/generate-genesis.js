/**
 * 제네시스 블록을 새로 만든다.
 *
 *   node scripts/generate-genesis.js [--network mainnet|testnet] [--write-wallet] [--force]
 *   node scripts/generate-genesis.js [--network ...] --rehash
 *
 * --rehash 는 기존 제네시스의 코인베이스(프리마인 주소, 금액, 타임스탬프)는
 * 그대로 두고 헤더만 지금 형식(version, bits)으로 다시 써서 해시를 새로
 * 만든다. 헤더 형식이 바뀌었을 때 프리마인 니모닉을 바꾸지 않고 쓴다.
 *
 * - 새 니모닉을 만들어 첫 받는 주소로 프리마인(높이 0 보조금)을 받는 제네시스를
 *   src/genesis.json (메인넷) 또는 src/genesis.testnet.json (테스트넷) 에 쓴다.
 *   공개 정보이므로 커밋 대상이다.
 * - --write-wallet 을 주면 그 니모닉을 src/wallet.json 에 쓴다. 안 주면 니모닉을
 *   화면에만 찍는다 — 옮겨 적지 않으면 프리마인은 아무도 쓸 수 없다. 공정한
 *   출발을 원하면 그게 맞다.
 *
 * 체인의 모든 노드는 같은 제네시스를 공유해야 한다.
 * 이미 src/wallet.json 이 있으면 --write-wallet 은 --force 없이는 덮어쓰지 않는다.
 */
const fs = require("fs"),
  path = require("path");

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at !== -1 && args[at + 1] ? args[at + 1] : fallback;
};

const network = option("--network", "mainnet");
process.env.LIMCOIN_NETWORK = network; // 아래 모듈들이 이 망의 주소 버전을 쓰게

const Params = require("../src/params");
const { getTxId, getBlockSubsidy } = require("../src/transactions");
const { getMerkleRoot } = require("../src/merkle");
const { blockHashOf, ZERO_HASH } = require("../src/serialization");
const { formatLim } = require("../src/units");
const Address = require("../src/address");
const HD = require("../src/hdwallet");
const BIP39 = require("../src/bip39");

// 제네시스 목표값 ≈ 2^241 — 평균 2^15 번 해시. 노트북 한 대로 초당 몇 블록.
const GENESIS_BITS = 0x1f01ffff;
const GENESIS_VERSION = 1;
const params = Params.current();

const walletLocation = path.join(__dirname, "..", "src", "wallet.json");
const genesisLocation = path.join(__dirname, "..", "src", params.genesisFile);

if (flag("--rehash")) {
  const existing = JSON.parse(fs.readFileSync(genesisLocation, "utf8"));
  const rehashed = {
    version: GENESIS_VERSION,
    index: 0,
    hash: "",
    previousHash: ZERO_HASH,
    timestamp: existing.timestamp,
    merkleRoot: getMerkleRoot(existing.data),
    data: existing.data,
    bits: GENESIS_BITS,
    nonce: 0
  };
  rehashed.hash = blockHashOf(rehashed);
  fs.writeFileSync(genesisLocation, JSON.stringify(rehashed, null, 2) + "\n");
  console.log(`${params.name} 제네시스의 헤더를 새 형식으로 다시 썼습니다.`);
  console.log("  주소   :", existing.data[0].txOuts[0].address, "(그대로)");
  console.log("  블록해시:", existing.hash, "->", rehashed.hash);
  process.exit(0);
}

if (flag("--write-wallet") && fs.existsSync(walletLocation) && !flag("--force")) {
  console.error(
    `이미 ${walletLocation} 가 있습니다.\n` +
      `덮어쓰면 기존 지갑의 잔액에 접근할 수 없게 됩니다. 정말 새로 만들려면 --force 를 주세요.`
  );
  process.exit(1);
}

const mnemonic = BIP39.generateMnemonic();
const seed = BIP39.mnemonicToSeed(mnemonic);
const address = Address.addressFromPublicKey(
  HD.getPublicKey(HD.derivePrivateKey(seed, HD.RECEIVE, 0)),
  params.addressVersion
);

// 제네시스 코인베이스는 높이 0 의 보조금을 그대로 받는다(수수료 없음).
const genesisTx = {
  txIns: [{ signature: "", txOutId: "", txOutIndex: 0 }],
  txOuts: [{ address, amount: getBlockSubsidy(0) }],
  id: ""
};
genesisTx.id = getTxId(genesisTx);

const genesisBlock = {
  version: GENESIS_VERSION,
  index: 0,
  hash: "",
  previousHash: ZERO_HASH,
  timestamp: Math.round(new Date().getTime() / 1000),
  merkleRoot: getMerkleRoot([genesisTx]),
  data: [genesisTx],
  bits: GENESIS_BITS,
  nonce: 0
};
// 헤더 88바이트의 sha256d — 노드가 쓰는 것과 같은 함수다 (serialization.js)
genesisBlock.hash = blockHashOf(genesisBlock);

if (flag("--write-wallet")) {
  fs.writeFileSync(
    walletLocation,
    JSON.stringify({ version: 2, mnemonic, nextReceive: 1, nextChange: 0, imported: [] }, null, 2) + "\n",
    { mode: 0o600 }
  );
}
fs.writeFileSync(genesisLocation, JSON.stringify(genesisBlock, null, 2) + "\n");

console.log(`새 ${params.name} 제네시스 블록을 만들었습니다.`);
console.log("  주소   :", address);
console.log("  프리마인:", formatLim(genesisTx.txOuts[0].amount), "LIM");
console.log("  머클루트:", genesisBlock.merkleRoot);
console.log("  블록해시:", genesisBlock.hash);
console.log("  제네시스:", genesisLocation, "(커밋 대상)");
console.log();
if (flag("--write-wallet")) {
  console.log("  지갑   :", walletLocation, "(니모닉이 들어 있다. 커밋 금지)");
}
console.log("  프리마인 주소의 니모닉 — 옮겨 적지 않으면 이 코인은 아무도 쓸 수 없다:");
console.log("   ", mnemonic);
