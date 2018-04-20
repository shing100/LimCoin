const CryptoJS = require("crypto-js");

class Block{
  constructor(index, hash, previousHash, timestamp, data){
    this.index = index;
    this.hash = hash;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.data = data;
  }
}

const genesisBlock = new Block(
  0,
  "D0124ED72DDCF46D7493B291D7101BF06564FE0CC54544633CA8D75AA6E456A5",
  null,
  1524220929129,
  "This is the Genesis!"
);

let blockchain = [genesisBlock];

const getLastBlock = () => blockchain[blockchain.length - 1];

// function getLastBlock() {
//   return blockchain[blockchain.length-1];
// }

const getTimestamp = () => new Date().getTime() / 1000;

const createHash = (index, previousHash, timestamp, JSON.stringify(data)) => CryptoJS.SHA256(index+previousHash+timestamp+data).toString();

const createNewBlock = data = > {
  const previousBlock = getLastBlock();
  const newBlockIndex = previousBlock.index + 1;
  const newTimestamp = getTimeStamp();
  const newHash = createHash(
    newBlockIndex,
    previousBlock.hash,
    newTimestamp,
    data
  );

  const newBlock = new Block(
    newBlockIndex,
    newHash,
    previousBlock.hash,
    newTimestamp,
    data
  );

  return newBlock;
}

const getBlockHash = (block) => createHash(block.index, block.previousHash, block.timestamp, block.data);

const isNewBlockValid = (candidateBlock, latestBlock) => {
  if(latestBlock.index + 1 !== candidateBlock.index){
    console.log('The block doesnt have a valid index')
    return false;
  }else if(latestBlock.hash !== candidateBlock.previousHash){
    console.log('The previousHash of the candidate block is not the hash of the latest block');
    return false;
  }else if(getBlockHash(candidateBlock) !== candidateBlock.hash) {
    console.log('The hash of this block is invalid')
    return false;
  }
  return true;
};

const isNewStructureValid = (block) => {
  return (
    typeof block.index === 'number' &&
    typeof block.hash === 'string' &&
    typeof block.previousHash === 'string' &&
    typeof block.timestamp === 'number' &&
    typeof block.data === 'string'
  );
};
