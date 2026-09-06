const CryptoJS = require("crypto-js"),
  _ = require("lodash"),
  Wallet = require("./wallet"),
  Mempool = require("./memPool"),
  Transactions = require("./transactions"),
  hexToBinary = require("hex-to-binary");

const { getBalance, getPublicFromWallet, createTx, getPrivateFromWallet  } = Wallet;

const { createCoinbaseTx, processTxs } = Transactions;

const { addToMempool, getMempool, updateMempool } = Mempool;

const BlOCK_GENERATION_INTERVAL = 10;  //  블록 생성 주기
const DIFFICULTY_ADJUSMENT_INTERVAL = 10; // 난이도 조정 주기
const TIMESTAMP_MINIT = 60;
const MIN_DIFFICULTY = 1; // 0 이면 어떤 해시든 통과해 버린다

class Block{
  constructor(index, hash, previousHash, timestamp, data, difficulty, nonce){
    this.index = index;
    this.hash = hash;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
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

// 해쉬 생성하기
const createHash = (index, previousHash, timestamp, data, difficulty, nonce) =>
  CryptoJS.SHA256(
    index+previousHash+timestamp+JSON.stringify(data)+difficulty+nonce
  ).toString();

// 코인 기반 새로운 블록 생성하기
const createNewBlock = () => {
  const coinbaseTx = createCoinbaseTx(getPublicFromWallet(), getNewestBlock().index + 1);
  // 다른 채굴 코인을 Mempool에 추가하기
  const blockData = [coinbaseTx].concat(getMempool());

  return createNewRawBlock(blockData);
};

// 새 블록 추가하기
const createNewRawBlock = data => {
  const previousBlock = getNewestBlock();
  const newBlockIndex = previousBlock.index + 1;
  const newTimestamp = getTimestamp();
  const difficulty = findDifficulty();
  const newBlock = findBlock(
    newBlockIndex,
    previousBlock.hash,
    newTimestamp,
    data,
    difficulty
  );
  addBlockToChain(newBlock); // 블록체인에 추가
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
    let nonce = 0;
    while(true){
      const hash = createHash(
        index,
        previousHash,
        timestamp,
        data,
        difficulty,
        nonce
      );
      //to do: check amount of zeros (hashMathesDifficulty)
      if(hashMatchesDifficulty(hash, difficulty)){
        return new Block(index, hash, previousHash, timestamp, data, difficulty, nonce);
      }
      nonce++
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
const getBlockHash = block => createHash(block.index, block.previousHash, block.timestamp, block.data, block.difficulty, block.nonce);

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
    typeof block.data === 'object'
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
    blockchain = candidateChain;
    uTxOuts = foreignUTxOuts;
    updateMempool(uTxOuts);
    require('./p2p').broadcastNewBlock();
    return true;
  }else{
    return false;
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
        getBlockChain().push(candidateBlock);
        uTxOuts = processedTxs;
        updateMempool(uTxOuts);
        return true;
    }
    //return true;
  }else{
    return false;
  }
};

// TxOutList 가져오기
const getUTxOutList = () => _.cloneDeep(uTxOuts);

// 지갑 정보 가져오기
const getAccountBalance = () => getBalance(getPublicFromWallet(), uTxOuts);

// 보내는 트렌젝션
const sendTx = (address, amount) => {
  const tx = createTx(address, amount, getPrivateFromWallet(), getUTxOutList(), getMempool());
  addToMempool(tx, getUTxOutList());
  require("./p2p").broadcastMempool();
  return tx;
};

const handleIncomingTx = (tx) => {
  addToMempool(tx, getUTxOutList());
};

module.exports = {
  replaceChain,
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
