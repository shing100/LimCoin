const CryptoJS = require("crypto-js"),
  hexToBinary = require("hex-to-binary");

const BlOCK_GENERATION_INTERVAL = 10;
const DIFFICULTY_ADJUSMENT_INTERVAL = 10;
const TIMESTAMP_MINIT = 60;

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

const genesisBlock = new Block(
  0,
  "D0124ED72DDCF46D7493B291D7101BF06564FE0CC54544633CA8D75AA6E456A5",
  null,
  1524382524,
  "This is the Genesis!",
  12,
  0
);

let blockchain = [genesisBlock];

const getNewestBlock = () => blockchain[blockchain.length - 1];

const getTimestamp = () => Math.round(new Date().getTime() / 1000);

const getBlockChain = () => blockchain;

const createHash = (index, previousHash, timestamp, data, difficulty, nonce) =>
  CryptoJS.SHA256(
    index+previousHash+timestamp+JSON.stringify(data)+difficulty+nonce
  ).toString();

const createNewBlock = data => {
  const previousBlock = getNewestBlock();
  const newBlockIndex = previousBlock.index + 1;
  const newTimestamp = getTimestamp();
  const difficulty = findDifficulty(getBlockChain());
  const newBlock = findBlock(
    newBlockIndex,
    previousBlock.hash,
    newTimestamp,
    data,
    difficulty
  );
  addBlockToChain(newBlock);
  require("./p2p").broadcastNewBlock();
  return newBlock;
}

const findDifficulty = () => {
  const newestBlock = getNewestBlock();
  if(newestBlock.index % DIFFICULTY_ADJUSMENT_INTERVAL === 0 && newestBlock.index !== 0) {
    return calculateNewDifficulty(newestBlock, getBlockChain());
  }else{
    return newestBlock.difficulty;
  }
}

const calculateNewDifficulty = (newestBlock, blockchain) => {
  const lastCalculatedBlock = blockchain[blockchain.length - DIFFICULTY_ADJUSMENT_INTERVAL];
  const timeExpected = BlOCK_GENERATION_INTERVAL * DIFFICULTY_ADJUSMENT_INTERVAL;
  const timeTaken = newestBlock.timestamp - lastCalculatedBlock.timestamp;
  if(timeTaken < timeExpected/2){
    return lastCalculatedBlock.difficulty + 1;
  }else if(timeTaken > timeExpected*2){
    return lastCalculatedBlock.difficulty - 1;
  }else{
    return lastCalculatedBlock.difficulty;
  }
}

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

const hashMatchesDifficulty = (hash, difficulty) => {
  const hashInBinary = hexToBinary(hash);
  const requiredZeros = "0".repeat(difficulty);
  console.log('Trying difficulty:',difficulty,'with hash', hash);
  return hashInBinary.startsWith(requiredZeros);
}

const isTimeStampValid = (newBlock, oldBlock) => {
  return (oldBlock.timestamp - TIMESTAMP_MINIT < newBlock.timestamp && newBlock.timestamp - TIMESTAMP_MINIT < getTimestamp())
}

const getBlockHash = block => createHash(block.index, block.previousHash, block.timestamp, block.data, block.difficulty, block.nonce);

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
  }
  return true;
};

const isBlockStructureValid = (block) => {
  return (
    typeof block.index === 'number' &&
    typeof block.hash === 'string' &&
    typeof block.previousHash === 'string' &&
    typeof block.timestamp === 'number' &&
    typeof block.data === 'string'
  );
};


const isChainValid = (candidateChain) => {
    const isGenesisValid = block => {
      return JSON.stringify(block) === JSON.stringify(genesisBlock);
    };
    if(!isGenesisValid(candidateChain[0])){
      console.log('The candidateChains genesisBlock is not the same as our genesisBlock');
      return false;
    };
    for(let i=1; i<candidateChain.length; i++){
      if(!isBlockValid(candidateChain[i], candidateChain[i-1])){
        return false;
      }
    };
    return true;
};


const replaceChain = candidateChain => {
  if(isChainValid(candidateChain) && candidateChain.length > getBlockChain().length){
    blockchain = candidateChain;
    return true;
  }else{
    return false;
  }
};

const addBlockToChain = candidateBlock => {
  if(isBlockValid(candidateBlock, getNewestBlock())){
    getBlockChain().push(candidateBlock);
    return true;
  }else{
    return false;
  }
};

module.exports = {
  replaceChain,
  addBlockToChain,
  isBlockStructureValid,
  getNewestBlock,
  getBlockChain,
  createNewBlock
};
