const Wallet = require("./wallet"),
  Mempool = require("./memPool"),
  Transactions = require("./transactions"),
  Merkle = require("./merkle"),
  Store = require("./store"),
  AddressIndex = require("./addressIndex"),
  ChainIndex = require("./chainIndex"),
  PoW = require("./pow"),
  { Worker } = require("worker_threads"),
  os = require("os"),
  path = require("path");

// 해시 계산은 워커와 함께 쓰므로 pow.js 에 따로 두었다
const { createHash } = PoW;

const { getMerkleRoot, getMerkleProof } = Merkle;

const { getWalletBalance, getPublicFromWallet, createTx } = Wallet;

const {
  createCoinbaseTx,
  processTxs,
  updateUTxOuts,
  collectConsumed,
  rollbackTxs,
  sumBlockFees,
  MAX_TXS_PER_BLOCK
} = Transactions;

const {
  addToMempool, getMempool, updateMempool, selectTxsForBlock, getSpendableUTxOuts
} = Mempool;
const { indexByOutpoint } = require("./utxo");

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
AddressIndex.applyBlock(genesisBlock, []);
ChainIndex.applyBlock(genesisBlock);

/*
 * 블록마다 "이 블록이 걷어 낸 UTxOut" 을 적어 둔다 (undo 데이터).
 * blockchain 과 자리가 1:1 로 맞아야 한다. 체인 교체 때 갈라진 지점까지만
 * 되감는 데 쓴다 — transactions.js 의 collectConsumed 주석 참고.
 */
let undoLog = [collectConsumed(genesisBlock.data, [])];

// 새로운 블록 가져오기
const getNewestBlock = () => blockchain[blockchain.length - 1];

// 타임스탬프
const getTimestamp = () => Math.round(new Date().getTime() / 1000);

// 블록체인 전체 가져오기
const getBlockChain = () => blockchain;

// 코인 기반 새로운 블록 생성하기
const createNewBlock = async () => {
  const nextIndex = getNewestBlock().index + 1;
  // 모듈 스코프의 uTxOuts 를 가리지 않게 이름을 달리한다
  const snapshot = getUTxOutList();

  // mempool 전체를 그대로 담던 것을 한도 안에서 수수료율 높은 순으로 고른다.
  // 코인베이스 자리 하나를 빼고 담는다.
  const selected = selectTxsForBlock(
    getMempool(),
    snapshot,
    MAX_TXS_PER_BLOCK - 1
  );
  /*
   * 수수료는 담기는 순서대로 세어야 한다. 앞선 트랜잭션이 만든 출력을
   * 뒤 트랜잭션이 쓰는 경우(chained send), 블록 이전의 UTxOut 만 보면
   * 그 입력이 "없는 출력"이 되어 수수료가 음수로 나온다.
   */
  const totalFees = sumBlockFees(selected, snapshot);

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
  const mining = findBlockInWorkers(
    newBlockIndex,
    previousBlock.hash,
    newTimestamp,
    data,
    difficulty
  );

  /*
   * 다른 노드가 먼저 블록을 올리면 헛돌지 않고 멈춘다.
   *
   * 워커에 중단을 알리는 것만으로는 promise 가 풀리지 않으므로
   * (워커는 아무 답도 보내지 않는다) 여기서 직접 거절한다.
   */
  let staleReject;
  const stale = new Promise((resolve, reject) => { staleReject = reject; });
  const cancelIfStale = setInterval(() => {
    if (getNewestBlock().hash !== previousBlock.hash) {
      mining.cancel();
      staleReject(Error("채굴하는 동안 다른 블록이 먼저 들어왔습니다. 다시 시도하세요."));
    }
  }, 500);
  // 아무도 안 받으면 unhandled rejection 으로 잡히므로 미리 삼켜 둔다
  stale.catch(() => {});

  let newBlock;
  try {
    newBlock = await Promise.race([mining, stale]);
  } finally {
    clearInterval(cancelIfStale);
  }

  // 취소가 늦었을 수도 있으니 한 번 더 본다
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
/*
 * chain 다음에 올 블록이 가져야 하는 난이도.
 *
 * 예전에는 우리 체인만 볼 수 있었다(findDifficulty). 그래서 남이 보낸
 * 후보 체인의 블록은 난이도를 스스로 정해도 아무도 따지지 않았다.
 * 검증하는 쪽은 그 체인의 앞부분을 기준으로 계산해야 한다.
 */
const difficultyForNext = chain => {
  const newestBlock = chain[chain.length - 1];
  if(newestBlock.index % DIFFICULTY_ADJUSMENT_INTERVAL === 0 && newestBlock.index !== 0) {
    return calculateNewDifficulty(newestBlock, chain);
  }else{
    return newestBlock.difficulty;
  }
}

const findDifficulty = () => difficultyForNext(getBlockChain());

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

/*
 * nonce 찾기를 워커 스레드에 맡긴다.
 *
 * 예전에는 메인 스레드에서 돌리되 일정 해시마다 이벤트 루프에 양보했다.
 * 그러면 HTTP 응답이 막히지는 않지만 채굴과 서버가 한 코어를 나눠 쓴다.
 * 워커로 빼면 채굴이 다른 코어에서 돌고 메인 스레드는 손대지 않는다.
 *
 * 워커는 풀로 살려 두고 일감만 보낸다. 블록마다 새로 띄우면 띄우는 값이
 * 채굴 시간보다 커질 수 있다 — 4코어에서 재 보니 워커 4개가 2개보다
 * 느렸다.
 *
 * 워커 k 는 k 부터 시작해 워커 수만큼씩 건너뛰므로 서로 겹치지 않는다.
 * 먼저 찾은 하나가 이기고 나머지에는 중단을 알린다.
 */
const WORKER_PATH = path.join(__dirname, "pow-worker.js");

const minerThreads = () => {
  const configured = Number.parseInt(process.env.LIMCOIN_MINER_THREADS, 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  // 메인 스레드가 쓸 코어 하나는 남긴다
  return Math.max(1, os.cpus().length - 1);
};

let pool = null;
let jobCounter = 0;

const getPool = () => {
  if (pool !== null) {
    return pool;
  }
  pool = [];
  for (let i = 0; i < minerThreads(); i++) {
    const worker = new Worker(WORKER_PATH);
    // 풀 때문에 프로세스가 안 끝나는 일이 없게 한다
    worker.unref();
    pool.push(worker);
  }
  return pool;
};

// 풀을 정리한다. 프로세스를 깔끔히 끝낼 때 쓴다.
const stopMiners = async () => {
  if (pool === null) {
    return;
  }
  const workers = pool;
  pool = null;
  await Promise.all(workers.map(worker => worker.terminate()));
};

const findBlockInWorkers = (index, previousHash, timestamp, data, difficulty) => {
  const merkleRoot = getMerkleRoot(data);
  const header = { index, previousHash, timestamp, merkleRoot, difficulty };

  const workers = getPool();
  const stride = workers.length;
  const jobId = ++jobCounter;

  const handlers = [];
  let settled = false;

  const release = () => {
    for (const [worker, onMessage, onError] of handlers) {
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      // 아직 도는 워커가 있으면 세운다
      worker.postMessage({ type: "stop", jobId });
    }
  };

  const promise = new Promise((resolve, reject) => {
    const finish = fn => value => {
      if (settled) {
        return;
      }
      settled = true;
      release();
      fn(value);
    };
    const win = finish(resolve);
    const fail = finish(reject);

    workers.forEach((worker, k) => {
      const onMessage = message => {
        // 지난 일감의 결과가 늦게 도착할 수 있다
        if (message.jobId !== jobId || message.type !== "found") {
          return;
        }
        win(
          new Block(
            index, message.hash, previousHash, timestamp,
            merkleRoot, data, difficulty, message.nonce
          )
        );
      };
      const onError = error => fail(error);

      worker.on("message", onMessage);
      worker.on("error", onError);
      handlers.push([worker, onMessage, onError]);

      worker.postMessage({ type: "mine", jobId, header, from: k, stride });
    });
  });

  // 다른 노드가 먼저 블록을 올렸을 때 헛돌지 않게 한다
  promise.cancel = () => {
    if (settled) {
      return;
    }
    for (const worker of workers) {
      worker.postMessage({ type: "stop", jobId });
    }
  };
  promise.threads = stride;
  return promise;
};

// 타임스탬프 유효성 검사
const isTimeStampValid = (newBlock, oldBlock) => {
  return (oldBlock.timestamp - TIMESTAMP_MINIT < newBlock.timestamp && newBlock.timestamp - TIMESTAMP_MINIT < getTimestamp())
}
// 헤시 만들기
const getBlockHash = block => createHash(block.index, block.previousHash, block.timestamp, block.merkleRoot, block.difficulty, block.nonce);

// genesis Block 초기 hash 값 넣기
//console.log(createHash(genesisBlock));
// 블록 유효성 체크하기
/*
 * 블록 유효성.
 *
 * expectedDifficulty 는 이 높이에서 프로토콜이 요구하는 난이도다.
 * 두 가지를 함께 봐야 작업증명이 성립한다.
 *
 *   1. 블록이 내건 난이도가 프로토콜이 정한 값과 같은가
 *   2. 해시가 실제로 그 난이도를 만족하는가
 *
 * 둘 다 없으면 난이도는 그냥 블록에 적힌 숫자일 뿐이다. 예전에는 해시가
 * 헤더와 맞는지만 봤기 때문에, 0 을 하나도 못 맞춘 해시로도 블록을 만들 수
 * 있었고 difficulty 에 큰 수를 적어 두면 sumDifficulty(2^difficulty) 가
 * 정직한 체인을 단번에 넘어섰다. 일 한 번 안 하고 체인을 갈아 끼울 수 있는
 * 셈이다.
 */
const isBlockValid = (candidateBlock, latestBlock, expectedDifficulty) => {
  if(!isBlockStructureValid(candidateBlock)){
    console.log('The candidate block structure is not valid');
    return false;
  }else if(typeof candidateBlock.difficulty !== 'number' || candidateBlock.difficulty < MIN_DIFFICULTY){
    console.log('The block difficulty is not valid');
    return false;
  }else if(expectedDifficulty !== undefined && candidateBlock.difficulty !== expectedDifficulty){
    console.log(`The block difficulty ${candidateBlock.difficulty} is not the expected ${expectedDifficulty}`);
    return false;
  }else if(!PoW.hashMatchesDifficulty(candidateBlock.hash, candidateBlock.difficulty)){
    console.log('The block hash does not meet the claimed difficulty');
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

/**
 * 두 체인이 앞에서부터 몇 블록이나 같은지 센다.
 * 해시가 같으면 그 블록은 같은 블록이다.
 */
const countCommonPrefix = (a, b) => {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i].hash === b[i].hash) {
    i++;
  }
  return i;
};

/**
 * 우리 체인을 common 번째 블록 직전 상태까지 되감은 UTxOut 집합.
 *
 * undo 데이터가 체인과 어긋나 있으면 null. 부르는 쪽이 예전처럼
 * 제네시스부터 재생하도록 한다 — 잘못된 UTxOut 집합을 들고 가느니
 * 느리게 가는 편이 낫다.
 */
const rewindTo = common => {
  if (undoLog.length !== blockchain.length) {
    console.log("undo 데이터가 체인과 어긋났습니다. 제네시스부터 다시 재생합니다.");
    return null;
  }
  let working = uTxOuts;
  for (let i = blockchain.length - 1; i >= common; i--) {
    working = rollbackTxs(blockchain[i].data, working, undoLog[i]);
  }
  return working;
};

/**
 * 후보 체인을 검증한다.
 *
 * 통과하면 { chain, uTxOuts, undo, common, uTxOutsAtCommon } 을,
 * 아니면 null 을 돌려준다.
 *
 * 우리 체인과 앞부분이 같으면 그 블록들은 이미 검증해 둔 것이다. 해시가
 * 같으면 헤더가 같고, 헤더는 머클 루트를, 머클 루트는 트랜잭션 id 를,
 * 트랜잭션 id 는 그 내용을 덮는다. 그러니 겹치는 만큼은 서명 검증을
 * 건너뛴다 — reorg 비용을 결정하는 것은 서명 검증이다.
 *
 * 나아가 겹치는 부분은 재생조차 하지 않는다. 우리 UTxOut 집합에서
 * 갈라진 블록들만 undo 데이터로 되감으면 그게 곧 공통 지점의 상태다.
 * 예전에는 서명 검증만 건너뛰고 재생은 제네시스부터 다시 했다.
 *
 * 다만 돌려주는 chain 의 앞부분은 *우리* 블록으로 채운다. 트랜잭션 id 는
 * 서명을 덮지 않으므로, 해시가 같으면서 서명 바이트만 다른 블록을 보낼 수
 * 있다. UTxOut 결과는 같지만 그걸 저장해 두면 남에게 거부당하는 블록을
 * 갖게 된다.
 */
const isChainValid = (candidateChain) => {
    if(!(candidateChain instanceof Array) || candidateChain.length === 0){
      console.log('The candidate chain is empty');
      return null;
    }
    /*
     * JSON.stringify 로 비교하면 키 순서가 곧 합의 규칙이 된다.
     * 해시 + 머클 루트 대조로 충분하다.
     */
    const isGenesisValid = block =>
      block.hash === genesisBlock.hash &&
      getMerkleRoot(block.data) === genesisBlock.merkleRoot;

    if(!isGenesisValid(candidateChain[0])){
      console.log('The candidateChains genesisBlock is not the same as our genesisBlock');
      return null;
    };

    const common = countCommonPrefix(blockchain, candidateChain);
    const chain = blockchain.slice(0, common);
    const undo = undoLog.slice(0, common);

    let working = rewindTo(common);
    if (working === null) {
      working = [];
      for (let i = 0; i < common; i++) {
        undo[i] = collectConsumed(chain[i].data, working);
        working = updateUTxOuts(chain[i].data, working);
      }
    }
    // 주소 색인을 갈라진 지점부터 다시 쌓을 때 시작점이 된다
    const uTxOutsAtCommon = working;

    for(let i = common; i < candidateChain.length; i++){
      const currentBlock = candidateChain[i];
      if(i !== 0 && !isBlockValid(currentBlock, candidateChain[i-1], difficultyForNext(chain))){
        return null;
      }

      // 재생하기 전의 집합에서 뽑아야 블록 안에서 만들어졌다 쓰인 출력이 빠진다
      const consumed = collectConsumed(currentBlock.data, working);
      const processed = processTxs(currentBlock.data, working, currentBlock.index);

      if(processed === null){
        return null;
      }
      working = processed;
      undo.push(consumed);
      chain.push(currentBlock);
    };
    return { chain, uTxOuts: working, undo, common, uTxOutsAtCommon };
};
// 난이도 구분하기
const sumDifficulty = anyBlockchain =>
  anyBlockchain
    .map(block => block.difficulty)
    .map(difficulty => Math.pow(2,difficulty))
    .reduce((a,b) => a + b, 0);
// 블록체인 재배치
const replaceChain = candidateChain => {
  const validated = isChainValid(candidateChain);
  if(
    validated !== null &&
    sumDifficulty(candidateChain) > sumDifficulty(getBlockChain())
  ){
    // 되돌려지는 블록에 담겼던 트랜잭션은 아직 유효할 수 있다.
    // 예전에는 그대로 사라져 버렸다.
    const orphaned = collectOrphanedTxs(blockchain, validated.chain);

    /*
     * 주소 색인도 갈라진 지점까지만 되감고 새 블록만 얹는다.
     * 예전에는 체인 전체를 다시 색인했다 — 한두 블록 갈라지자고
     * 만 블록을 다시 훑는 셈이었다.
     */
    const droppedFrom =
      validated.common < blockchain.length ? blockchain[validated.common].index : null;
    const dropped = blockchain.slice(validated.common);

    blockchain = validated.chain;
    uTxOuts = validated.uTxOuts;
    undoLog = validated.undo;

    if (droppedFrom !== null) {
      AddressIndex.rollbackTo(droppedFrom);
      ChainIndex.rollbackBlocks(dropped);
    }
    let indexed = validated.uTxOutsAtCommon;
    for (let i = validated.common; i < blockchain.length; i++) {
      AddressIndex.applyBlock(blockchain[i], indexed);
      ChainIndex.applyBlock(blockchain[i]);
      // 서명 검증은 isChainValid 에서 끝났으므로 여기서는 반영만 한다
      indexed = updateUTxOuts(blockchain[i].data, indexed);
    }

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
  // getUTxOutList() 는 deep clone 이다. mempool 에 넣는다고 UTxOut 집합이
  // 바뀌지는 않으므로 한 번만 뜬다. 예전에는 트랜잭션마다 복제했다.
  const snapshot = getUTxOutList();
  let restored = 0;
  for (const tx of txs) {
    try {
      addToMempool(tx, snapshot);
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
  if(isBlockValid(candidateBlock, getNewestBlock(), findDifficulty())){
    const processedTxs = processTxs(
      candidateBlock.data,
      uTxOuts,
      candidateBlock.index
    );
    if(processedTxs === null){
      console.log("Couldnt process txs");
      return false;
    }else{
        // 주소 색인은 이 블록 이전의 UTxOut 으로 입력을 되짚어야 하므로
        // uTxOuts 를 갈아 끼우기 전에 먼저 갱신한다.
        AddressIndex.applyBlock(candidateBlock, uTxOuts);
        ChainIndex.applyBlock(candidateBlock);
        blockchain.push(candidateBlock);
        undoLog.push(collectConsumed(candidateBlock.data, uTxOuts));
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
  // 예전에는 찾을 때까지 블록마다 머클 트리를 새로 쌓았다.
  // 색인이 어느 블록인지 알려 주므로 그 블록 하나만 쌓으면 된다.
  const block = getBlockByHeight(ChainIndex.findTxHeight(txId));
  if (block === undefined) {
    return null;
  }
  const proof = getMerkleProof(block.data, txId);
  if (proof === null) {
    return null;
  }
  return {
    txId,
    blockIndex: block.index,
    blockHash: block.hash,
    merkleRoot: block.merkleRoot,
    proof
  };
};

const getBlockByHeight = height =>
  height === undefined ? undefined : blockchain[height];

// 블록 해시로 블록 찾기. 예전에는 체인을 훑었다.
const getBlockByHash = hash => getBlockByHeight(ChainIndex.findBlockHeight(hash));

/**
 * 트랜잭션 id 로 찾기.
 *
 * 블록에 담긴 것이면 담긴 블록을 함께 준다. 아직 담기지 않았으면
 * mempool 에서 찾는다 — 익스플로러가 "대기 중"인 트랜잭션도 열어 볼 수
 * 있어야 한다. 예전에는 체인에 없으면 그냥 404 였다.
 */
const findTx = txId => {
  const block = getBlockByHeight(ChainIndex.findTxHeight(txId));
  if (block !== undefined) {
    const tx = block.data.find(candidate => candidate.id === txId);
    if (tx !== undefined) {
      return { tx, block, pending: false };
    }
  }
  const pending = getMempool().find(candidate => candidate.id === txId);
  return pending === undefined ? null : { tx: pending, block: null, pending: true };
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

  if (
    persisted[0].hash !== genesisBlock.hash ||
    getMerkleRoot(persisted[0].data) !== genesisBlock.merkleRoot
  ) {
    // genesis.json 을 새로 만들었는데 옛 체인이 남아 있는 경우
    console.log(
      "저장된 체인의 제네시스가 지금 genesis.json 과 다릅니다. 저장본을 버리고 새로 시작합니다."
    );
    Store.writeBlocks([genesisBlock]);
    return { restored: 0, height: 0 };
  }

  let chain = [persisted[0]];
  let undo = [collectConsumed(persisted[0].data, [])];
  let utxos = processTxs(persisted[0].data, [], 0);

  for (let i = 1; i < persisted.length; i++) {
    const block = persisted[i];
    if (!isBlockValid(block, chain[chain.length - 1], difficultyForNext(chain))) {
      console.log(`저장된 블록 #${block.index} 이 유효하지 않습니다. 여기까지만 복원합니다.`);
      break;
    }
    const processed = processTxs(block.data, utxos, block.index);
    if (processed === null) {
      console.log(`저장된 블록 #${block.index} 의 트랜잭션을 처리할 수 없습니다. 여기까지만 복원합니다.`);
      break;
    }
    chain.push(block);
    undo.push(collectConsumed(block.data, utxos));
    utxos = processed;
  }

  blockchain = chain;
  uTxOuts = utxos;
  undoLog = undo;
  rebuildIndexes();

  // 중간에 잘렸다면 파일도 맞춰 준다
  if (chain.length !== persisted.length) {
    Store.writeBlocks(chain);
  }

  return { restored: chain.length, height: chain[chain.length - 1].index };
};

// 색인은 체인을 처음부터 재생해야 만들 수 있다.
const rebuildIndexes = () => {
  AddressIndex.rebuild(blockchain, (block, before) =>
    processTxs(block.data, before, block.index)
  );
  ChainIndex.rebuild(blockchain);
};

// TxOutList 가져오기
/*
 * UTxOut 집합의 사본.
 *
 * 얕은 복사다. UTxOut 은 만들어진 뒤로는 아무도 고치지 않는다 —
 * 쓰이면 목록에서 빠질 뿐이다. 그러니 배열만 새로 만들어 주면
 * 밖에서 노드의 목록 자체를 건드리는 일은 막힌다.
 *
 * 예전에는 _.cloneDeep 이었다. UTxOut 2만 개 기준 한 번에 28.7ms 였고,
 * /info 와 /address/:address 가 부를 때마다 그 값을 냈다. 얕은 복사는
 * 0.12ms 다.
 */
const getUTxOutList = () => uTxOuts.slice();

// 지갑 정보 가져오기
const getAccountBalance = () => getWalletBalance(uTxOuts);

/*
 * 보내는 트랜잭션.
 *
 * 쓸 수 있는 것은 확정된 UTxOut 에 mempool 이 만든 출력을 더하고 mempool 이
 * 이미 쓴 것을 뺀 집합이다. 예전에는 확정된 것만 보고 골랐다. 그러면
 * 방금 보내고 남은 거스름돈이 블록에 담길 때까지 묶여서, 잔액이 남아
 * 있는데도 "Not enough funds" 가 났다 — 노드는 그런 트랜잭션(chained
 * send)을 받아 주는데 지갑이 만들지를 못했다.
 *
 * 확인 절차에는 확정된 집합을 그대로 넘긴다. addToMempool 이 안에서
 * 같은 계산을 하므로 두 번 더하면 안 된다.
 */
const sendTx = (address, amount, fee = 0) => {
  const confirmed = getUTxOutList();
  const tx = createTx(
    address,
    amount,
    getSpendableUTxOuts(confirmed),
    getMempool(),
    fee
  );
  addToMempool(tx, confirmed);
  require("./p2p").broadcastMempool();
  return tx;
};

// 확정 잔액과, mempool 까지 반영한 실제로 쓸 수 있는 잔액
const getSpendableBalance = () => getWalletBalance(getSpendableUTxOuts(uTxOuts));

/*
 * 피어에게 받은 트랜잭션을 mempool 에 넣는다.
 *
 * 낱개로 부르지 않고 묶어서 받는다 — getUTxOutList() 가 deep clone 이라
 * 트랜잭션마다 부르면 피어가 보낸 mempool 크기만큼 복제가 일어난다.
 * 유효하지 않은 것은 건너뛴다(이미 쓰인 UTxO 를 가리키는 등).
 */
const handleIncomingTxs = txs => {
  const snapshot = getUTxOutList();
  for (const tx of txs) {
    try {
      addToMempool(tx, snapshot);
    } catch (e) {
      console.log(`피어가 보낸 트랜잭션을 받지 못했습니다: ${e.message}`);
    }
  }
};

module.exports = {
  replaceChain,
  countCommonPrefix,
  stopMiners,
  initChain,
  rebuildIndexes,
  getTxProof,
  getBlockByHash,
  getBlockByHeight,
  findTx,
  calculateNewDifficulty,
  difficultyForNext,
  isBlockValid,
  addBlockToChain,
  isBlockStructureValid,
  getNewestBlock,
  getBlockChain,
  createNewBlock,
  getAccountBalance,
  getSpendableBalance,
  sendTx,
  handleIncomingTxs,
  getUTxOutList
};
