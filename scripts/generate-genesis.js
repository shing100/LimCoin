/**
 * 제네시스 블록을 새로 만든다.
 *
 *   node scripts/generate-genesis.js [--force]
 *
 * - 새 키쌍을 만들어 src/privateKey 에 쓴다 (.gitignore 대상, 절대 커밋하지 말 것)
 * - 그 주소로 프리마인을 받는 제네시스 블록을 src/genesis.json 에 쓴다 (공개 정보, 커밋 대상)
 *
 * 체인의 모든 노드는 같은 genesis.json 을 공유해야 한다.
 * 이미 src/privateKey 가 있으면 덮어쓰지 않는다(--force 로 강제).
 */
const CryptoJS = require("crypto-js"),
  fs = require("fs"),
  path = require("path");

const { getTxId, getBlockSubsidy } = require("../src/transactions");
const { getMerkleRoot } = require("../src/merkle");
const { formatLim } = require("../src/units");
const HD = require("../src/hdwallet");
const BIP39 = require("../src/bip39");

const GENESIS_DIFFICULTY = 15;

const walletLocation = path.join(__dirname, "..", "src", "wallet.json");
const genesisLocation = path.join(__dirname, "..", "src", "genesis.json");

const force = process.argv.includes("--force");

if (fs.existsSync(walletLocation) && !force) {
  console.error(
    `이미 ${walletLocation} 가 있습니다.\n` +
      `덮어쓰면 기존 지갑의 잔액에 접근할 수 없게 됩니다. 정말 새로 만들려면 --force 를 주세요.`
  );
  process.exit(1);
}

// 씨앗 하나에서 필요한 만큼 주소를 파생한다(BIP32).
// 백업할 것은 니모닉 하나뿐이다(BIP39).
const mnemonic = BIP39.generateMnemonic();
const seed = BIP39.mnemonicToSeed(mnemonic);
const address = HD.getPublicKey(HD.derivePrivateKey(seed, HD.RECEIVE, 0));

// 제네시스 코인베이스는 높이 0 의 보조금을 그대로 받는다(수수료 없음).
const genesisTx = {
  txIns: [{ signature: "", txOutId: "", txOutIndex: 0 }],
  txOuts: [{ address, amount: getBlockSubsidy(0) }],
  id: ""
};
genesisTx.id = getTxId(genesisTx);

const genesisBlock = {
  index: 0,
  hash: "",
  previousHash: "",
  timestamp: Math.round(new Date().getTime() / 1000),
  merkleRoot: getMerkleRoot([genesisTx]),
  data: [genesisTx],
  difficulty: GENESIS_DIFFICULTY,
  nonce: 0
};

// blockchain.js 의 createHash 와 동일한 식이어야 한다.
// 본문이 아니라 머클 루트가 들어간다(백서 7장).
genesisBlock.hash = CryptoJS.SHA256(
  genesisBlock.index +
    genesisBlock.previousHash +
    genesisBlock.timestamp +
    genesisBlock.merkleRoot +
    genesisBlock.difficulty +
    genesisBlock.nonce
).toString();

fs.writeFileSync(
  walletLocation,
  JSON.stringify({ version: 2, mnemonic, nextReceive: 1, nextChange: 0, imported: [] }, null, 2) + "\n"
);
fs.writeFileSync(genesisLocation, JSON.stringify(genesisBlock, null, 2) + "\n");

console.log("새 제네시스 블록을 만들었습니다.");
console.log("  주소   :", address);
console.log("  프리마인:", formatLim(genesisTx.txOuts[0].amount), "LIM");
console.log("  머클루트:", genesisBlock.merkleRoot);
console.log("  블록해시:", genesisBlock.hash);
console.log("  지갑   :", walletLocation, "(니모닉이 들어 있다. 커밋 금지)");
console.log();
console.log("  복구용 니모닉 — 안전한 곳에 옮겨 적어 두세요:");
console.log("   ", mnemonic);
console.log("  제네시스:", genesisLocation, "(커밋 대상)");
