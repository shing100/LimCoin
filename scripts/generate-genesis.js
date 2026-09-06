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
  elliptic = require("elliptic"),
  fs = require("fs"),
  path = require("path");

const { getTxId } = require("../src/transactions");

const ec = new elliptic.ec("secp256k1");

const COINBASE_AMOUNT = 10;
const GENESIS_DIFFICULTY = 15;

const privateKeyLocation = path.join(__dirname, "..", "src", "privateKey");
const genesisLocation = path.join(__dirname, "..", "src", "genesis.json");

const force = process.argv.includes("--force");

if (fs.existsSync(privateKeyLocation) && !force) {
  console.error(
    `이미 ${privateKeyLocation} 가 있습니다.\n` +
      `덮어쓰면 기존 지갑의 잔액에 접근할 수 없게 됩니다. 정말 새로 만들려면 --force 를 주세요.`
  );
  process.exit(1);
}

const keyPair = ec.genKeyPair();
const privateKey = keyPair.getPrivate().toString(16);
const address = keyPair.getPublic().encode("hex");

const genesisTx = {
  txIns: [{ signature: "", txOutId: "", txOutIndex: 0 }],
  txOuts: [{ address, amount: COINBASE_AMOUNT }],
  id: ""
};
genesisTx.id = getTxId(genesisTx);

const genesisBlock = {
  index: 0,
  hash: "",
  previousHash: "",
  timestamp: Math.round(new Date().getTime() / 1000),
  data: [genesisTx],
  difficulty: GENESIS_DIFFICULTY,
  nonce: 0
};

// blockchain.js 의 createHash 와 동일한 식이어야 한다.
genesisBlock.hash = CryptoJS.SHA256(
  genesisBlock.index +
    genesisBlock.previousHash +
    genesisBlock.timestamp +
    JSON.stringify(genesisBlock.data) +
    genesisBlock.difficulty +
    genesisBlock.nonce
).toString();

fs.writeFileSync(privateKeyLocation, privateKey);
fs.writeFileSync(genesisLocation, JSON.stringify(genesisBlock, null, 2) + "\n");

console.log("새 제네시스 블록을 만들었습니다.");
console.log("  주소   :", address);
console.log("  블록해시:", genesisBlock.hash);
console.log("  개인키 :", privateKeyLocation, "(커밋 금지)");
console.log("  제네시스:", genesisLocation, "(커밋 대상)");
