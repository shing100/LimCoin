const CryptoJS = require("crypto-js"),
  _ = require("lodash"),
  Wallet = require("./wallet"),
  Mempool = require("./memPool"),
  Transactions = require("./transactions"),
  Merkle = require("./merkle"),
  Store = require("./store"),
  hexToBinary = require("hex-to-binary");

const { getMerkleRoot, getMerkleProof } = Merkle;

const { getBalance, getPublicFromWallet, createTx, getPrivateFromWallet  } = Wallet;

const { createCoinbaseTx, processTxs, getTxFee, MAX_TXS_PER_BLOCK } = Transactions;

const { addToMempool, getMempool, updateMempool, selectTxsForBlock } = Mempool;

const BlOCK_GENERATION_INTERVAL = 10;  //  블록 생성 주기
const DIFFICULTY_ADJUSMENT_INTERVAL = 10; // 난이도 조정 주기
const TIMESTAMP_MINIT = 60;
const MIN_DIFFICULTY = 1; // 0 이면 어떤 해시든 통과해 버린다

/*
 * 블록 = 헤더 + 본문.
 *
 * 헤더가 커밋하는 것은 index, previousHash, timestamp, merkleRoot,
 * difficulty, nonce 뿐이다. 트랜잭션 목록(data)은 머클 루트를 통해서만
 * 묶인다 — 백서 7장 "transactions are hashed in a Merkle Tree, with only
 * the root included in the block's hash".
 *
 * 예전에는 JSON.stringify(data) 를 해시에 통째로 넣었다. 그러면 직렬화
 * 방식이 곧 합의 규칙이 되어 버리고(키 순서가 바뀌면 해시가 달라진다),
 * 트랜잭션 하나가 블록에 있는지 확인하려면 블록 전체를 받아야 했다.
 */
class Block{
  constructor(index, hash, previousHash, timestamp, merkleRoot, data, difficulty, nonce){
    this.index = index;
    this.hash = hash;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.merkleRoot = merkleRoot;
    this.data = data;
    this.difficulty = difficulty;
    this.nonce = nonce;
  }
}

// 제네시스 블록은 genesis.json 에서 읽는다.
// 새 체인을 띄우려면 `node scripts/generate-genesis.js` 로 다시 만들 것.
// (하드코딩 시절 쓰던 주소는 개인키가 저장소에 함께 커밋되어 폐기되었다)
const genesisData = require("./genesis.json");

const genesisBlock = new Block(
  genesisData.index,
  genesisData.hash,
  genesisData.previousHash,
  genesisData.timestamp,
  genesisData.merkleRoot,
  genesisData.data,
  genesisData.difficulty,
  genesisData.nonce
);

// 블록체인
let blockchain = [genesisBlock];

let uTxOuts = processTxs(blockchain[0].data, [], 0);

// 새로운 블록 가져오기
const getNewestBlock = () => blockchain[blockchain.length - 1];

// 타임스탬프
const getTimestamp = () => Math.round(new Date().getTime() / 1000);

// 블록체인 전체 가져오기
const getBlockChain = () => blockchain;

// 헤더 해시. 본문(data)이 아니라 머클 루트만 들어간다.
const createHash = (index, previousHash, timestamp, merkleRoot, difficulty, nonce) =>
  CryptoJS.SHA256(
    index+previousHash+timestamp+merkleRoot+difficulty+nonce
  ).toString();

// 코인 기반 새로운 블록 생성하기
const createNewBlock = async () => {
  const nextIndex = getNewestBlock().index + 1;
  const uTxOuts = getUTxOutList();

  // mempool 전체를 그대로 담던 것을 한도 안에서 수수료율 높은 순으로 고른다.
  // 코인베이스 자리 하나를 빼고 담는다.
  const selected = selectTxsForBlock(
    getMempool(),
    uTxOuts,
    MAX_TXS_PER_BLOCK - 1
  );
  const totalFees = selected.reduce(
    (sum, tx) => sum + getTxFee(tx, uTxOuts),
    0
  );

  // 채굴자는 보조금에 더해 담은 트랜잭션들의 수수료를 가져간다 (백서 6장)
  const coinbaseTx = createCoinbaseTx(getPublicFromWallet(), nextIndex, totalFees);

  return await createNewRawBlock([coinbaseTx, ...selected]);
};

// 새 블록 추가하기
const createNewRawBlock = async data => {
  const previousBlock = getNewestBlock();
  const newBlockIndex = previousBlock.index + 1;
  const newTimestamp = getTimestamp();
  const difficulty = findDifficulty();
  const newBlock = await findBlockAsync(
    newBlockIndex,
    previousBlock.hash,
    newTimestamp,
    data,
    difficulty
  );
  // 채굴하는 사이에 다른 노드가 먼저 블록을 올렸을 수 있다
  if (newBlock.previousHash !== getNewestBlock().hash) {
    throw Error("채굴하는 동안 다른 블록이 먼저 들어왔습니다. 다시 시도하세요.");
  }
  if (!addBlockToChain(newBlock)) {
    throw Error("채굴한 블록이 검증을 통과하지 못했습니다");
  }
  require("./p2p").broadcastNewBlock(); // 연결시 브로드케스팅
  return newBlock;
}

// 블록 난이도 찾기 와 조정
const findDifficulty = () => {
  const newestBlock = getNewestBlock();
  if(newestBlock.index % DIFFICULTY_ADJUSMENT_INTERVAL === 0 && newestBlock.index !== 0) {
    return calculateNewDifficulty(newestBlock, getBlockChain());
  }else{
    return newestBlock.difficulty;
  }
}

// 난이도 계산기
const calculateNewDifficulty = (newestBlock, blockchain) => {
  const lastCalculatedBlock = blockchain[blockchain.length - DIFFICULTY_ADJUSMENT_INTERVAL];
  const timeExpected = BlOCK_GENERATION_INTERVAL * DIFFICULTY_ADJUSMENT_INTERVAL;
  const timeTaken = newestBlock.timestamp - lastCalculatedBlock.timestamp;
  if(timeTaken < timeExpected/2){
    return lastCalculatedBlock.difficulty + 1;
  }else if(timeTaken > timeExpected*2){
    return Math.max(MIN_DIFFICULTY, lastCalculatedBlock.difficulty - 1);
  }else{
    return lastCalculatedBlock.difficulty;
  }
}

// nonce를 이용하여 원하는 블록 찾기
const findBlock = (index, previousHash, timestamp, data, difficulty) => {
    // 본문은 채굴 중에 바뀌지 않으므로 머클 루트는 한 번만 구하면 된다.
    // 예전에는 nonce 를 돌릴 때마다 트랜잭션 전체를 JSON 으로 직렬화했다.
    const merkleRoot = getMerkleRoot(data);
    let nonce = 0;
    while(true){
      const hash = createHash(
        index,
        previousHash,
        timestamp,
        merkleRoot,
        difficulty,
        nonce
      );
      if(hashMatchesDifficulty(hash, difficulty)){
        return new Block(index, hash, previousHash, timestamp, merkleRoot, data, difficulty, nonce);
      }
      nonce++
    }
};

/*
 * 위 findBlock 은 동기 while 루프라 도는 동안 HTTP 응답도 P2P 소켓도
 * 전부 멈춘다. 난이도 15 는 평균 3만 해시라 1초 남짓이지만, 20 이면
 * 100만 해시다.
 *
 * 같은 일을 하되 일정 횟수마다 이벤트 루프에 양보한다. 진짜 채굴이라면
 * worker_threads 로 빼야 하지만, 그러면 코어가 워커 진입점을 따로 갖게
 * 되어 배우기에는 오히려 흐려진다.
 */
const HASHES_PER_TICK = 20000;

const findBlockAsync = async (index, previousHash, timestamp, data, difficulty) => {
  const merkleRoot = getMerkleRoot(data);
  let nonce = 0;
  while (true) {
    for (let i = 0; i < HASHES_PER_TICK; i++) {
      const hash = createHash(index, previousHash, timestamp, merkleRoot, difficulty, nonce);
      if (hashMatchesDifficulty(hash, difficulty)) {
        return new Block(index, hash, previousHash, timestamp, merkleRoot, data, difficulty, nonce);
      }
      nonce++;
    }
    // 여기서 다른 요청과 소켓 메시지가 처리된다
    await new Promise(resolve => setImmediate(resolve));
  }
};
// 난이도 0 찾기 조정
const hashMatchesDifficulty = (hash, difficulty = 15) => {
  const hashInBinary = hexToBinary(hash);
  const requiredZeros = "0".repeat(difficulty);
  //console.log('Trying difficulty:',difficulty,'with hash', hash);
  return hashInBinary.startsWith(requiredZeros);
}
// 타임스탬프 유효성 검사
const isTimeStampValid = (newBlock, oldBlock) => {
  return (oldBlock.timestamp - TIMESTAMP_MINIT < newBlock.timestamp && newBlock.timestamp - TIMESTAMP_MINIT < getTimestamp())
}
// 헤시 만들기
const getBlockHash = block => createHash(block.index, block.previousHash, block.timestamp, block.merkleRoot, block.difficulty, block.nonce);

// genesis Block 초기 hash 값 넣기
//console.log(createHash(genesisBlock));
// 블록 유효성 체크하기
const isBlockValid = (candidateBlock, latestBlock) => {
  if(!isBlockStructureValid(candidateBlock)){
    console.log('The candidate block structure is not valid');
    return false;
  }else if(latestBlock.index + 1 !== candidateBlock.index){
    console.log('The block doesnt have a valid index')
    return false;
  }else if(latestBlock.hash !== candidateBlock.previousHash){
    console.log('The previousHash of the candidate block is not the hash of the latest block');
    return false;
  }else if(getMerkleRoot(candidateBlock.data) !== candidateBlock.merkleRoot) {
    // 이 검사가 없으면 머클 루트는 장식일 뿐이다.
    // 헤더 해시는 맞는데 본문이 다른 블록을 걸러 낸다.
    console.log('The merkle root does not match the transactions in this block');
    return false;
  }else if(getBlockHash(candidateBlock) !== candidateBlock.hash) {
    console.log('The hash of this block is invalid')
    return false;
  }else if(!isTimeStampValid(candidateBlock, latestBlock)) {
    console.log("The timestamp of this block is invalid");
    return false;
  }
  return true;
};

// 블록 유효성 체크
const isBlockStructureValid = (block) => {
  return (
    typeof block.index === 'number' &&
    typeof block.hash === 'string' &&
    typeof block.previousHash === 'string' &&
    typeof block.timestamp === 'number' &&
    typeof block.merkleRoot === 'string' &&
    block.data instanceof Array
  );
};

// 블록체인 유효성 검사하기
const isChainValid = (candidateChain) => {
    if(!(candidateChain instanceof Array) || candidateChain.length === 0){
      console.log('The candidate chain is empty');
      return null;
    }
    const isGenesisValid = block => {
      return JSON.stringify(block) === JSON.stringify(genesisBlock);
    };
    if(!isGenesisValid(candidateChain[0])){
      console.log('The candidateChains genesisBlock is not the same as our genesisBlock');
      return null;
    };
    // 다른 포트에도 TxOUt 을 적용하기 위한 단계
    let foreignUTxOuts = [];

    for(let i=0; i<candidateChain.length; i++){
      const currentBlock = candidateChain[i];
      if(i !== 0 && !isBlockValid(currentBlock, candidateChain[i-1])){
        return null;
      }

      foreignUTxOuts = processTxs(currentBlock.data, foreignUTxOuts, currentBlock.index);

      if(foreignUTxOuts === null){
        return null;
      }
    };
    return foreignUTxOuts;
};
// 난이도 구분하기
const sumDifficulty = anyBlockchain =>
  anyBlockchain
    .map(block => block.difficulty)
    .map(difficulty => Math.pow(2,difficulty))
    .reduce((a,b) => a + b, 0);
// 블록체인 재배치
const replaceChain = candidateChain => {
  const foreignUTxOuts = isChainValid(candidateChain);
  const validChain = foreignUTxOuts !== null;
  if(
    validChain &&
    sumDifficulty(candidateChain) > sumDifficulty(getBlockChain())
  ){
    // 되돌려지는 블록에 담겼던 트랜잭션은 아직 유효할 수 있다.
    // 예전에는 그대로 사라져 버렸다.
    const orphaned = collectOrphanedTxs(blockchain, candidateChain);

    blockchain = candidateChain;
    uTxOuts = foreignUTxOuts;
    updateMempool(uTxOuts);
    // 체인 교체는 append 로 표현할 수 없으므로 파일을 새로 쓴다
    Store.writeBlocks(blockchain);
    reinstateTxs(orphaned);
    require('./p2p').broadcastNewBlock();
    return true;
  }else{
    return false;
  }
};
/*
 * 체인이 교체될 때, 밀려난 블록에만 있던 트랜잭션을 추린다.
 * 새 체인에 이미 담겨 있는 것은 뺀다.
 */
const collectOrphanedTxs = (oldChain, newChain) => {
  const kept = new Set();
  newChain.forEach(block =>
    (block.data || []).forEach(tx => kept.add(tx.id))
  );

  const orphaned = [];
  oldChain.forEach(block =>
    (block.data || []).forEach(tx => {
      // 코인베이스는 그 블록에만 속하므로 되살리지 않는다
      const isCoinbase = tx.txIns.length === 1 && tx.txIns[0].txOutId === "";
      if (!isCoinbase && !kept.has(tx.id)) {
        orphaned.push(tx);
      }
    })
  );
  return orphaned;
};

// 밀려난 트랜잭션을 mempool 로 되돌린다.
// 새 체인 기준으로 더는 유효하지 않은 것은 조용히 버린다.
const reinstateTxs = txs => {
  let restored = 0;
  for (const tx of txs) {
    try {
      addToMempool(tx, getUTxOutList());
      restored++;
    } catch (e) {
      // 이미 다른 트랜잭션이 같은 UTxO 를 썼거나 유효하지 않게 된 경우
    }
  }
  if (restored > 0) {
    console.log(`체인 교체로 밀려난 트랜잭션 ${restored}건을 mempool 로 되돌렸습니다`);
  }
};

// 블록 체인 더하기
const addBlockToChain = candidateBlock => {
  if(isBlockValid(candidateBlock, getNewestBlock())){
    const processedTxs = processTxs(
      candidateBlock.data,
      uTxOuts,
      candidateBlock.index
    );
    if(processedTxs === null){
      console.log("Couldnt process txs");
      return false;
    }else{
        blockchain.push(candidateBlock);
        uTxOuts = processedTxs;
        updateMempool(uTxOuts);
        Store.appendBlock(candidateBlock);
        return true;
    }
    //return true;
  }else{
    return false;
  }
};

/*
 * 백서 8장 "Simplified Payment Verification".
 * 블록 전체를 받지 않고도 트랜잭션이 그 블록에 담겼음을 확인할 수 있게
 * 머클 증명을 내준다. 검증하는 쪽은 헤더의 merkleRoot 만 있으면 된다.
 */
const getTxProof = txId => {
  for (const block of blockchain) {
    const proof = getMerkleProof(block.data, txId);
    if (proof !== null) {
      return {
        txId,
        blockIndex: block.index,
        blockHash: block.hash,
        merkleRoot: block.merkleRoot,
        proof
      };
    }
  }
  return null;
};

/**
 * 저장된 체인을 읽어 이어서 시작한다. 서버가 뜰 때 한 번 부른다.
 *
 * 저장된 블록을 하나씩 다시 검증하며 UTxOut 집합을 재구성한다. 검증에
 * 실패하는 블록이 나오면 거기서 멈춘다 — 뒤쪽은 P2P 로 다시 받으면 된다.
 */
const initChain = (dataDir) => {
  Store.open(dataDir);
  const persisted = Store.loadBlocks();

  if (persisted.length === 0) {
    // 처음 뜨는 노드. 제네시스만 저장해 둔다.
    Store.appendBlock(genesisBlock);
    return { restored: 0, height: 0 };
  }

  if (persisted[0].hash !== genesisBlock.hash) {
    // genesis.json 을 새로 만들었는데 옛 체인이 남아 있는 경우
    console.log(
      "저장된 체인의 제네시스가 지금 genesis.json 과 다릅니다. 저장본을 버리고 새로 시작합니다."
    );
    Store.writeBlocks([genesisBlock]);
    return { restored: 0, height: 0 };
  }

  let chain = [persisted[0]];
  let utxos = processTxs(persisted[0].data, [], 0);

  for (let i = 1; i < persisted.length; i++) {
    const block = persisted[i];
    if (!isBlockValid(block, chain[chain.length - 1])) {
      console.log(`저장된 블록 #${block.index} 이 유효하지 않습니다. 여기까지만 복원합니다.`);
      break;
    }
    const processed = processTxs(block.data, utxos, block.index);
    if (processed === null) {
      console.log(`저장된 블록 #${block.index} 의 트랜잭션을 처리할 수 없습니다. 여기까지만 복원합니다.`);
      break;
    }
    chain.push(block);
    utxos = processed;
  }

  blockchain = chain;
  uTxOuts = utxos;

  // 중간에 잘렸다면 파일도 맞춰 준다
  if (chain.length !== persisted.length) {
    Store.writeBlocks(chain);
  }

  return { restored: chain.length, height: chain[chain.length - 1].index };
};

// TxOutList 가져오기
const getUTxOutList = () => _.cloneDeep(uTxOuts);

// 지갑 정보 가져오기
const getAccountBalance = () => getBalance(getPublicFromWallet(), uTxOuts);

// 보내는 트렌젝션
const sendTx = (address, amount, fee = 0) => {
  const tx = createTx(address, amount, getPrivateFromWallet(), getUTxOutList(), getMempool(), fee);
  addToMempool(tx, getUTxOutList());
  require("./p2p").broadcastMempool();
  return tx;
};

const handleIncomingTx = (tx) => {
  addToMempool(tx, getUTxOutList());
};

module.exports = {
  replaceChain,
  initChain,
  getTxProof,
  calculateNewDifficulty,
  addBlockToChain,
  isBlockStructureValid,
  getNewestBlock,
  getBlockChain,
  createNewBlock,
  getAccountBalance,
  sendTx,
  handleIncomingTx,
  getUTxOutList
};
