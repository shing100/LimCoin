const Wallet = require("./wallet"),
  Mempool = require("./memPool"),
  Transactions = require("./transactions"),
  Merkle = require("./merkle"),
  Store = require("./store"),
  AddressIndex = require("./addressIndex"),
  ChainIndex = require("./chainIndex"),
  PoW = require("./pow"),
  Target = require("./target"),
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
  isSpendable,
  COINBASE_MATURITY,
  MAX_TXS_PER_BLOCK,
  MAX_BLOCK_BYTES
} = Transactions;

const {
  addToMempool, getMempool, updateMempool, selectTxsForBlock,
  getSpendableUTxOuts, getMatureUTxOuts
} = Mempool;

const BlOCK_GENERATION_INTERVAL = 10;  //  블록 생성 주기(초)
// 헤더 version. 규칙을 바꿀 때 채굴자가 새 값을 적어 찬성을 표시하는 자리다.
const BLOCK_VERSION = 1;

/*
 * 되감을 수 있는 최대 깊이.
 *
 * 공개 해시레이트가 적은 체인의 가장 큰 위험은 "빌린 해시레이트로 처음부터
 * 다시 캐서 더 무거운 체인을 내미는 것"이다. 무게만 보면 그런 체인이
 * 이긴다. 그래서 우리가 이미 100블록 넘게 쌓은 자리는 다시 쓰지 않는다.
 *
 * 값을 치른다: 정말로 그만큼 뒤처진 노드는 스스로 따라잡지 못하고 갈라진
 * 채로 남는다. 그때는 LIMCOIN_MAX_REORG_DEPTH=0 으로 끄고 다시 뜨거나
 * 데이터 디렉터리를 비우고 처음부터 받아야 한다. 비트코인에는 이 규칙이
 * 없다 — 해시레이트가 충분하면 필요 없기 때문이다.
 */
const configuredReorgDepth = Number.parseInt(process.env.LIMCOIN_MAX_REORG_DEPTH, 10);
const MAX_REORG_DEPTH = Number.isInteger(configuredReorgDepth) ? configuredReorgDepth : 100;

// undo 데이터를 들고 있을 깊이. 되감을 수 있는 깊이보다 넉넉해야 한다.
const KEEP_UNDO = 200;

// 스냅샷을 몇 블록마다 남길지
const SNAPSHOT_INTERVAL = 500;
/*
 * 타임스탬프 규칙. 비트코인과 같은 방식이다.
 *
 * 예전에는 "직전 블록 -60초 이후, 그리고 내 시계 +60초 이내" 였다.
 * 두 가지가 잘못돼 있었다.
 *
 *  - 뒤로 60초까지 갈 수 있었다. 난이도는 타임스탬프 차이로 정해지므로
 *    (timeTaken = 최신 - 10블록 전) 시간을 뒤로 밀면 timeTaken 이 커져
 *    난이도가 내려간다. 블록을 조작해 난이도를 낮출 수 있었다.
 *  - 미래로는 60초까지만 허용했다. 노드 사이 시계가 조금만 어긋나도
 *    정직한 블록이 거부된다 — 그것만으로 체인이 갈라진다.
 *
 * 이제 직전 11블록 타임스탬프의 중앙값(MTP)보다 커야 하고, 내 시계보다
 * 2시간 넘게 앞서면 안 된다. 중앙값이라 과반을 쥐지 않으면 시간을 뒤로
 * 밀 수 없고, 2시간은 시계 오차를 넉넉히 덮는다.
 */
const MEDIAN_TIME_SPAN = 11;
const MAX_FUTURE_BLOCK_TIME = 2 * 60 * 60;

/*
 * 블록 = 헤더 + 본문.
 *
 * 헤더가 커밋하는 것은 version, index, previousHash, timestamp, merkleRoot,
 * bits, nonce 뿐이다. 트랜잭션 목록(data)은 머클 루트를 통해서만
 * 묶인다 — 백서 7장 "transactions are hashed in a Merkle Tree, with only
 * the root included in the block's hash".
 *
 * 예전에는 JSON.stringify(data) 를 해시에 통째로 넣었다. 그러면 직렬화
 * 방식이 곧 합의 규칙이 되어 버리고(키 순서가 바뀌면 해시가 달라진다),
 * 트랜잭션 하나가 블록에 있는지 확인하려면 블록 전체를 받아야 했다.
 */
class Block{
  constructor(version, index, hash, previousHash, timestamp, merkleRoot, data, bits, nonce){
    this.version = version;
    this.index = index;
    this.hash = hash;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.merkleRoot = merkleRoot;
    this.data = data;
    this.bits = bits;
    this.nonce = nonce;
  }
}

// 제네시스 블록은 genesis.json 에서 읽는다.
// 새 체인을 띄우려면 `node scripts/generate-genesis.js` 로 다시 만들 것.
// (하드코딩 시절 쓰던 주소는 개인키가 저장소에 함께 커밋되어 폐기되었다)
const Params = require("./params");
const genesisData = require(Params.current().genesisFile);

const genesisBlock = new Block(
  genesisData.version,
  genesisData.index,
  genesisData.hash,
  genesisData.previousHash,
  genesisData.timestamp,
  genesisData.merkleRoot,
  genesisData.data,
  genesisData.bits,
  genesisData.nonce
);

/* ------------------------------------------- 블록 본문은 디스크에
 *
 * 체인을 통째로 메모리에 들고 있었다. 300블록·트랜잭션 1457건짜리 작은
 * 체인에서도 본문이 863KB 로 전체의 63% 였고, 이 몫은 체인이 길어지는 만큼
 * 끝없이 는다. 반면 UTxOut 집합은 "아직 안 쓴 출력"만큼만 늘고, 헤더는
 * 블록당 300바이트다.
 *
 * 그래서 메모리에는 헤더만 두고, 본문은 필요할 때 그 줄만 디스크에서
 * 읽는다(store.js 의 readBlockAt). 읽어 온 본문은 최근 것만 캐시에 남긴다.
 *
 * 부르는 쪽은 달라지지 않는다 — 헤더 객체의 `data` 는 getter 라서
 * `block.data` 도, JSON.stringify(block) 도 그대로 된다. 저장소를 열지
 * 않았으면(테스트) 본문을 버리지 않고 다 들고 있는다.
 */
const configuredCache = Number.parseInt(process.env.LIMCOIN_BLOCK_CACHE, 10);
const BODY_CACHE_SIZE = Number.isInteger(configuredCache) && configuredCache > 0 ? configuredCache : 600;
const bodyCache = new Map(); // height -> data

const cacheBody = (height, data) => {
  bodyCache.delete(height);
  bodyCache.set(height, data);
  if (Store.isOpen()) {
    while (bodyCache.size > BODY_CACHE_SIZE) {
      // Map 은 넣은 순서를 지킨다. 가장 오래된 것부터 버린다.
      bodyCache.delete(bodyCache.keys().next().value);
    }
  }
};

const bodyAt = height => {
  if (bodyCache.has(height)) {
    const data = bodyCache.get(height);
    // 최근에 쓴 것으로 옮겨 둔다
    bodyCache.delete(height);
    bodyCache.set(height, data);
    return data;
  }
  const stored = Store.readBlockAt(height);
  if (stored === null) {
    return undefined;
  }
  cacheBody(height, stored.data);
  return stored.data;
};

/*
 * 이 블록에 트랜잭션이 몇 건인가 — **본문을 읽지 않고** 알아낸다.
 *
 * 헤더만 메모리에 두고 본문은 디스크에서 그때그때 읽는 구조라, 통계를 내려고
 * block.data.length 를 부르면 블록마다 디스크를 한 번씩 친다. 개수는 기록을
 * 만들 때 이미 손에 있으므로 그때 적어 둔다.
 *
 * 이미 헤더 기록인 것(txCount 를 가진 것)을 다시 감쌀 때는 그 값을 물려받는다.
 * data 를 건드리면 getter 가 깨어나 디스크를 읽는다 — 그러면 안 담은 이유가 없다.
 */
const txCountOf = block => {
  if (typeof block.txCount === "number") {
    return block.txCount;
  }
  const own = Object.getOwnPropertyDescriptor(block, "data");
  if (own !== undefined && own.get === undefined && Array.isArray(own.value)) {
    return own.value.length;
  }
  return null; // 알 수 없다 (본문을 읽어야 안다)
};

/*
 * 본문을 떼어 낸 헤더 기록. `data` 는 그때그때 읽어 온다.
 * height 는 배열에서의 자리다(제네시스가 0). block.index 와 같다.
 */
const headerRecordOf = (block, height) => {
  const record = {
    version: block.version,
    index: block.index,
    hash: block.hash,
    previousHash: block.previousHash,
    timestamp: block.timestamp,
    merkleRoot: block.merkleRoot,
    bits: block.bits,
    nonce: block.nonce,
    txCount: txCountOf(block)
  };
  Object.defineProperty(record, "data", {
    enumerable: true,
    configurable: true,
    get: () => bodyAt(height)
  });
  return record;
};

// 헤더 기록으로 이루어진 체인을 만든다. 본문이 있는 것은 캐시에 넣어 둔다.
const toHeaderChain = (blocks, from = 0) =>
  blocks.map((block, at) => {
    const height = from + at;
    const own = Object.getOwnPropertyDescriptor(block, "data");
    // getter 면 캐시에 넣지 않는다 — 넣으면 undefined 를 굳혀 버릴 수 있다
    if (own !== undefined && own.get === undefined) {
      cacheBody(height, block.data);
    }
    return headerRecordOf(block, height);
  });

// 블록체인 (헤더만. 본문은 위 getter 로 읽는다)
let blockchain = [genesisBlock];

let uTxOuts = processTxs(genesisBlock.data, [], 0, 0);
blockchain = toHeaderChain([genesisBlock]);
AddressIndex.applyBlock(genesisBlock, []);
ChainIndex.applyBlock(genesisBlock);

/*
 * 블록마다 "이 블록이 걷어 낸 UTxOut" 을 적어 둔다 (undo 데이터).
 * blockchain 과 자리가 1:1 로 맞아야 한다. 체인 교체 때 갈라진 지점까지만
 * 되감는 데 쓴다 — transactions.js 의 collectConsumed 주석 참고.
 */
let undoLog = [collectConsumed(genesisBlock.data, [])];

// 다음 블록이 붙을 높이. 성숙도 검사의 기준이 된다.
const nextHeight = () => getNewestBlock().index + 1;

// 새로운 블록 가져오기
const getNewestBlock = () => blockchain[blockchain.length - 1];

// 타임스탬프
const getTimestamp = () => Math.round(new Date().getTime() / 1000);

// 블록체인 전체 가져오기
const getBlockChain = () => blockchain;

/*
 * 채굴 보상을 받을 주소.
 *
 * LIMCOIN_MINING_ADDRESS 가 있으면 그 주소로 — 노드 지갑이 아닌, 이 기계에
 * 키가 없는 주소(콜드 지갑)로 받을 수 있다. 채굴 노드가 뚫려도 보상은 안전하다.
 * 지갑이 꺼져 있으면 이 값이 없이는 채굴할 수 없다.
 */
const miningAddress = () => {
  const configured = process.env.LIMCOIN_MINING_ADDRESS;
  if (configured) {
    if (!Transactions.isAddressValid(configured)) {
      throw Error(`LIMCOIN_MINING_ADDRESS 가 이 망의 주소가 아닙니다: ${configured}`);
    }
    return configured;
  }
  if (!Wallet.isEnabled()) {
    throw Error("지갑이 꺼져 있습니다. 채굴하려면 LIMCOIN_MINING_ADDRESS 를 주세요.");
  }
  return getPublicFromWallet();
};

// 코인 기반 새로운 블록 생성하기
/*
 * 채굴하는 동안 새 트랜잭션이 들어오면 템플릿을 다시 만든다.
 *
 * 예전에는 블록 하나를 다 찾을 때까지 처음 담은 트랜잭션만 돌렸다. 그래서
 * 트랜잭션은 "지금 파는 블록"에는 못 들어가고 그 다음 블록을 기다렸다 —
 * 확인까지 평균 1.5블록이 걸렸다. 작업증명은 해시 한 번 한 번이 독립이라
 * (기억이 없다) 도중에 템플릿을 갈아도 지금까지 한 일을 잃는 게 아니다.
 * 그래서 새 트랜잭션이 오면 바로 갈아 끼운다. 블록이 이미 꽉 찼으면
 * 갈 일이 없다.
 */
const TEMPLATE_STALE = "TEMPLATE_STALE";

const createNewBlock = async () => {
  for (;;) {
    try {
      return await mineTemplate();
    } catch (e) {
      if (e.code !== TEMPLATE_STALE) {
        throw e;
      }
      // 새 트랜잭션을 담아 다시 판다
    }
  }
};

const mineTemplate = async () => {
  const nextIndex = getNewestBlock().index + 1;
  // 모듈 스코프의 uTxOuts 를 가리지 않게 이름을 달리한다
  const snapshot = getUTxOutList();

  // mempool 전체를 그대로 담던 것을 한도 안에서 수수료율 높은 순으로 고른다.
  // 코인베이스 자리 하나를 빼고 담는다.
  /*
   * 코인베이스 자리를 미리 빼 둔다. 블록 한도는 바이트가 먼저고 건수는
   * 안전판이다 — 코인베이스는 한 건에 200바이트쯤 든다.
   */
  const COINBASE_RESERVE = 400;
  const selected = selectTxsForBlock(
    getMempool(),
    snapshot,
    { maxTxs: MAX_TXS_PER_BLOCK - 1, maxBytes: MAX_BLOCK_BYTES - COINBASE_RESERVE },
    nextIndex
  );
  /*
   * 수수료는 담기는 순서대로 세어야 한다. 앞선 트랜잭션이 만든 출력을
   * 뒤 트랜잭션이 쓰는 경우(chained send), 블록 이전의 UTxOut 만 보면
   * 그 입력이 "없는 출력"이 되어 수수료가 음수로 나온다.
   */
  const totalFees = sumBlockFees(selected, snapshot);

  // 채굴자는 보조금에 더해 담은 트랜잭션들의 수수료를 가져간다 (백서 6장)
  const coinbaseTx = createCoinbaseTx(miningAddress(), nextIndex, totalFees);

  const full =
    selected.length >= MAX_TXS_PER_BLOCK - 1 ||
    selected.reduce((sum, tx) => sum + Transactions.getTxSize(tx), 0) >=
      MAX_BLOCK_BYTES - COINBASE_RESERVE;
  return await createNewRawBlock([coinbaseTx, ...selected], { restartOnNewTx: !full });
};

// 새 블록 추가하기
const createNewRawBlock = async (data, { restartOnNewTx = false } = {}) => {
  const previousBlock = getNewestBlock();
  const newBlockIndex = previousBlock.index + 1;
  /*
   * MTP 보다 커야 한다. 블록이 몇 초 안에 여러 개 나오면 시계가 같은
   * 초를 가리켜 중앙값이 지금과 같아질 수 있으므로, 그때는 한 칸 민다.
   * (비트코인 코어의 GetMinimumTime 과 같은 처리다)
   */
  const newTimestamp = Math.max(getTimestamp(), medianTimePast(blockchain) + 1);
  const bits = bitsForNext(blockchain, newTimestamp);
  const mining = findBlockInWorkers(
    newBlockIndex,
    previousBlock.hash,
    newTimestamp,
    data,
    bits
  );

  /*
   * 다른 노드가 먼저 블록을 올리면 헛돌지 않고 멈춘다.
   * cancel() 이 채굴 promise 를 거절로 끝내므로 await 가 바로 풀린다.
   */
  const cancelIfStale = setInterval(() => {
    if (getNewestBlock().hash !== previousBlock.hash) {
      mining.cancel("채굴하는 동안 다른 블록이 먼저 들어왔습니다. 다시 시도하세요.");
    }
  }, 500);

  // mempool 이 바뀌면(새 트랜잭션, 또는 남의 블록이 붙어 빠진 것) 템플릿을 새로 만든다
  let stopListening = () => {};
  if (restartOnNewTx) {
    stopListening = Mempool.onChange(() => {
      const stale = Error("채굴하는 동안 mempool 이 바뀌어 템플릿을 다시 만듭니다");
      stale.code = TEMPLATE_STALE;
      mining.cancel(stale);
    });
  }

  let newBlock;
  try {
    newBlock = await mining;
  } finally {
    clearInterval(cancelIfStale);
    stopListening();
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

// 다음 블록의 목표값
/*
 * chain 다음에 올 블록이 가져야 하는 bits(압축 목표값).
 *
 * 검증하는 쪽은 *후보 체인의* 앞부분을 기준으로 계산한다 — 우리 체인만
 * 보면 남이 보낸 체인의 난이도를 따질 수 없다. 채굴하는 쪽도 같은 함수를
 * 쓰므로 둘이 어긋날 수 없다.
 *
 * 목표값은 블록마다 LWMA 로 고친다(target.js). 처음 lwmaWindow 블록은
 * 제네시스의 목표값을 그대로 쓴다.
 */
const bitsForNext = (chain, newTimestamp) => {
  const newestBlock = chain[chain.length - 1];
  const params = Params.current();

  /*
   * 테스트넷의 "20분 규칙" (비트코인 fPowAllowMinDifficultyBlocks).
   *
   * 큰 채굴자가 난이도를 올려 놓고 떠나면 남은 노트북은 블록 하나에 몇
   * 시간이 걸려 체인이 사실상 멎는다. 테스트넷은 값어치가 없으므로, 직전
   * 블록 뒤로 목표 주기의 20배(200초)가 지났으면 그 블록은 최소 난이도로
   * 만들어도 받아 준다. 그 다음 블록은 원래 난이도로 돌아간다 — LWMA 창
   * 안에서 특별 블록은 중립으로 취급한다(isSpecialBlock).
   * 메인넷에는 없다 — 시간을 앞당겨 적은 채굴자가 난이도를 피할 수 있으므로.
   */
  if (
    params.allowMinDifficultyBlocks &&
    typeof newTimestamp === "number" &&
    newTimestamp > newestBlock.timestamp + BlOCK_GENERATION_INTERVAL * 20
  ) {
    return Target.POW_LIMIT_BITS;
  }

  return Target.nextTargetBits(chain, {
    T: BlOCK_GENERATION_INTERVAL,
    N: params.lwmaWindow,
    genesisBits: genesisBlock.bits,
    isSpecial: params.allowMinDifficultyBlocks ? isSpecialBlock : () => false
  });
};

// 테스트넷 특별(최소 난이도) 블록인가: 직전 블록보다 200초 넘게 뒤이고 bits 가 바닥이다
const isSpecialBlock = (i, chain) =>
  i > 0 &&
  chain[i].bits === Target.POW_LIMIT_BITS &&
  chain[i].timestamp > chain[i - 1].timestamp + BlOCK_GENERATION_INTERVAL * 20;

// 지금 채굴하면 써야 할 bits
const findBits = () => bitsForNext(getBlockChain(), getTimestamp());

/*
 * mempool 에 넣을 때 쓰는 "지금 시각" — 내 시계가 아니라 체인 끝의 MTP 다.
 * 시각 기반 lockTime 은 블록에 담길 때 MTP 로 판정되므로, 미리 볼 때도 같은
 * 잣대를 써야 "받아 놓고 담지 못하는" 트랜잭션이 생기지 않는다.
 */
const tipMedianTime = () => medianTimePast(getBlockChain());

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
  const workers = [];
  for (let i = 0; i < minerThreads(); i++) {
    const worker = new Worker(WORKER_PATH);
    // 풀 때문에 프로세스가 안 끝나는 일이 없게 한다
    worker.unref();
    /*
     * 워커가 죽으면(예외, 메모리) 풀을 통째로 버린다. 다음 채굴이 새로 띄운다.
     * 예전에는 죽은 워커가 풀에 남아, 그 워커에 보낸 일감은 영원히 답이 없었다
     * — 워커가 하나면 채굴이 통째로 멎었다.
     */
    worker.once("exit", () => {
      if (pool === workers) {
        pool = null;
        for (const other of workers) {
          if (other !== worker) {
            other.terminate();
          }
        }
      }
    });
    workers.push(worker);
  }
  pool = workers;
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

const findBlockInWorkers = (index, previousHash, timestamp, data, bits) => {
  const merkleRoot = getMerkleRoot(data);
  const header = { version: BLOCK_VERSION, index, previousHash, timestamp, merkleRoot, bits };

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

  let fail = null;
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
    fail = finish(reject);

    workers.forEach((worker, k) => {
      const onMessage = message => {
        // 지난 일감의 결과가 늦게 도착할 수 있다
        if (message.jobId !== jobId || message.type !== "found") {
          return;
        }
        win(
          new Block(
            BLOCK_VERSION, index, message.hash, previousHash, timestamp,
            merkleRoot, data, bits, message.nonce
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

  /*
   * 다른 노드가 먼저 블록을 올렸을 때 헛돌지 않게 한다.
   *
   * promise 를 거절로 끝낸다 — 그래야 release() 가 돌아 워커에 붙인
   * 리스너가 떨어지고 중단 신호가 간다. 예전에는 중단 신호만 보내고 promise 를
   * 매달아 둬서, 블록 경쟁에서 질 때마다 워커마다 리스너가 하나씩 쌓였다
   * (열 번쯤 지면 MaxListenersExceededWarning, 메모리는 계속 늘었다).
   */
  promise.cancel = reason => {
    if (fail !== null) {
      fail(reason instanceof Error ? reason : Error(reason || "채굴을 중단했습니다"));
    }
  };
  return promise;
};

// 타임스탬프 유효성 검사
// 직전 MEDIAN_TIME_SPAN 블록 타임스탬프의 중앙값
const medianTimePast = chain => {
  if (chain.length === 0) {
    return 0;
  }
  const recent = chain
    .slice(-MEDIAN_TIME_SPAN)
    .map(block => block.timestamp)
    .sort((a, b) => a - b);
  return recent[Math.floor(recent.length / 2)];
};

const isTimeStampValid = (newBlock, chainSoFar) =>
  newBlock.timestamp > medianTimePast(chainSoFar) &&
  newBlock.timestamp <= getTimestamp() + MAX_FUTURE_BLOCK_TIME;
// 헤더 해시
const getBlockHash = block => createHash(headerOf(block));

// genesis Block 초기 hash 값 넣기
//console.log(createHash(genesisBlock));
// 블록 유효성 체크하기
/*
 * 블록 유효성.
 *
 * chainSoFar 는 이 블록 앞에 오는 체인이다. 난이도와 타임스탬프 하한
 * (MTP)이 둘 다 한 블록이 아니라 앞선 여러 블록에서 나오므로, 직전
 * 블록 하나만으로는 검증할 수 없다.
 *
 * 작업증명은 두 가지를 함께 봐야 성립한다.
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
const isBlockValid = (candidateBlock, chainSoFar) => {
  if(!isBlockStructureValid(candidateBlock)){
    console.log('The candidate block structure is not valid');
    return false;
  }
  if(violatesCheckpoint(candidateBlock)){
    return false;
  }
  if(!isHeaderValid(candidateBlock, chainSoFar)){
    return false;
  }
  if(getMerkleRoot(candidateBlock.data) !== candidateBlock.merkleRoot) {
    // 이 검사가 없으면 머클 루트는 장식일 뿐이다.
    // 헤더 해시는 맞는데 본문이 다른 블록을 걸러 낸다.
    console.log('The merkle root does not match the transactions in this block');
    return false;
  }
  return true;
};

/*
 * 헤더만으로 할 수 있는 검증 — 본문(data)이 없어도 된다.
 *
 * 동기화할 때 헤더를 먼저 받아 이것으로 검증하고 무게를 비교한 뒤, 더
 * 무거울 때만 블록을 받는다. 헤더는 한 개에 300바이트쯤이라 체인 전체를
 * 받아도 부담이 작다. 머클 루트가 본문과 맞는지는 블록이 올 때 본다.
 */
const isHeaderValid = (header, chainSoFar) => {
  const latestBlock = chainSoFar[chainSoFar.length - 1];

  if(!isHeaderStructureValid(header)){
    console.log('The header structure is not valid');
    return false;
  }
  if(header.version < 1){
    console.log('The block version is not valid');
    return false;
  }
  if(!Target.isValidBits(header.bits)){
    console.log(`The block bits are not valid: ${header.bits}`);
    return false;
  }
  const expectedBits = bitsForNext(chainSoFar, header.timestamp);
  if(header.bits !== expectedBits){
    console.log(`The block bits ${header.bits.toString(16)} are not the expected ${expectedBits.toString(16)}`);
    return false;
  }else if(!PoW.hashMeetsBits(header.hash, header.bits)){
    console.log('The block hash does not meet the claimed target');
    return false;
  }else if(latestBlock.index + 1 !== header.index){
    console.log('The block doesnt have a valid index')
    return false;
  }else if(latestBlock.hash !== header.previousHash){
    console.log('The previousHash of the candidate block is not the hash of the latest block');
    return false;
  }else if(getBlockHash(header) !== header.hash) {
    console.log('The hash of this block is invalid')
    return false;
  }else if(!isTimeStampValid(header, chainSoFar)) {
    console.log("The timestamp of this block is invalid");
    return false;
  }
  return true;
};

// 헤더 필드만 본다. 남이 보낸 것이므로 객체인지부터.
const isHeaderStructureValid = header =>
  header !== null &&
  typeof header === "object" &&
  Number.isInteger(header.version) &&
  typeof header.index === 'number' &&
  typeof header.hash === 'string' &&
  typeof header.previousHash === 'string' &&
  typeof header.timestamp === 'number' &&
  typeof header.merkleRoot === 'string' &&
  Number.isInteger(header.bits) &&
  typeof header.nonce === 'number';

// 블록에서 헤더만 떼어 낸다 (본문 없이 보낼 때)
const headerOf = block => ({
  version: block.version,
  index: block.index,
  hash: block.hash,
  previousHash: block.previousHash,
  timestamp: block.timestamp,
  merkleRoot: block.merkleRoot,
  bits: block.bits,
  nonce: block.nonce
});

// 블록 유효성 체크
const isBlockStructureValid = (block) => {
  // 남이 보낸 것이므로 객체인지부터 본다. 숫자나 null 이 올 수 있다.
  if (block === null || typeof block !== "object") {
    return false;
  }
  return (
    Number.isInteger(block.version) &&
    typeof block.index === 'number' &&
    typeof block.hash === 'string' &&
    typeof block.previousHash === 'string' &&
    typeof block.timestamp === 'number' &&
    typeof block.merkleRoot === 'string' &&
    Number.isInteger(block.bits) &&
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
    if (undoLog[i] === null) {
      // 오래된 블록의 undo 는 버렸다(KEEP_UNDO). 그만큼 깊이 갈 일은 없지만.
      console.log(`블록 #${i} 의 undo 데이터가 없습니다. 제네시스부터 다시 재생합니다.`);
      return null;
    }
    working = rollbackTxs(blockchain[i].data, working, undoLog[i]);
  }
  return working;
};

// 오래된 undo 데이터는 버린다. 배열 자리는 남겨 두어 인덱스가 어긋나지 않게 한다.
const trimUndoLog = () => {
  for (let i = undoLog.length - KEEP_UNDO - 1; i >= 0; i--) {
    if (undoLog[i] === null) {
      break;
    }
    undoLog[i] = null;
  }
};

/*
 * 체크포인트 — 그 높이의 블록은 반드시 정해진 해시여야 한다 (params.js).
 * 그 높이보다 앞을 다시 쓰는 체인은 아무리 무거워도 받지 않는다.
 */
// 못박아 둔 가장 높은 높이 (없으면 -1)
const lastCheckpointHeight = () =>
  Params.current().checkpoints.reduce((highest, [height]) => Math.max(highest, height), -1);

const violatesCheckpoint = block => {
  for (const [height, hash] of Params.current().checkpoints) {
    if (block.index === height && block.hash !== hash) {
      console.log(`블록 #${height} 이 체크포인트(${hash})와 다릅니다: ${block.hash}`);
      return true;
    }
  }
  return false;
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

    /*
     * 우리가 이미 깊이 쌓은 자리를 다시 쓰려는 체인은 받지 않는다.
     * 무게만 보면 이기는 체인이라도 그렇다 (MAX_REORG_DEPTH).
     */
    /*
     * 체크포인트보다 앞에서 갈라지는 체인은 받지 않는다.
     *
     * 블록마다 보는 검사(violatesCheckpoint)만으로는 모자란다 — 체크포인트
     * 높이에 아예 블록이 없는(그보다 짧은) 체인은 그 검사를 지나쳐 버리고,
     * 무게만 무거우면 못박아 둔 블록을 지워 버릴 수 있다.
     */
    const checkpoint = lastCheckpointHeight();
    if (checkpoint >= 0 && common <= checkpoint && blockchain.length > checkpoint) {
      console.log(
        `체크포인트(높이 ${checkpoint})보다 앞(${common})에서 갈라지는 체인입니다. 받지 않습니다.`
      );
      return null;
    }

    const rewindDepth = blockchain.length - common;
    if (MAX_REORG_DEPTH > 0 && rewindDepth > MAX_REORG_DEPTH) {
      console.log(
        `${rewindDepth}블록을 되감으라는 체인입니다. 상한은 ${MAX_REORG_DEPTH} 입니다 ` +
          `(LIMCOIN_MAX_REORG_DEPTH 로 조절).`
      );
      return null;
    }

    const chain = blockchain.slice(0, common);
    const undo = undoLog.slice(0, common);

    let working = rewindTo(common);
    if (working === null) {
      working = [];
      for (let i = 0; i < common; i++) {
        undo[i] = collectConsumed(chain[i].data, working);
        working = updateUTxOuts(chain[i].data, working, chain[i].index);
      }
    }
    // 주소 색인을 갈라진 지점부터 다시 쌓을 때 시작점이 된다
    const uTxOutsAtCommon = working;

    for(let i = common; i < candidateChain.length; i++){
      const currentBlock = candidateChain[i];
      if(i !== 0 && !isBlockValid(currentBlock, chain)){
        return null;
      }

      // 재생하기 전의 집합에서 뽑아야 블록 안에서 만들어졌다 쓰인 출력이 빠진다
      const consumed = collectConsumed(currentBlock.data, working);
      const processed = processTxs(currentBlock.data, working, currentBlock.index, medianTimePast(chain));

      if(processed === null){
        return null;
      }
      working = processed;
      undo.push(consumed);
      chain.push(currentBlock);
    };
    return { chain, uTxOuts: working, undo, common, uTxOutsAtCommon };
};
// 체인의 무게 = 블록마다 목표값을 맞히는 데 드는 평균 해시 횟수(2^256/(target+1))의 합. BigInt.
// 헤더만 있어도 셀 수 있다 — 동기화 때 블록을 받기 전에 비교하는 데 쓴다.
const chainWork = anyBlockchain =>
  anyBlockchain.reduce((sum, block) => sum + Target.workOf(block.bits), 0n);

/*
 * 우리 체인의 누적 일한 양 — 높이별로 들고 있는다.
 *
 * chainWork 는 배열을 통째로 훑는다. 그런데 이 값을 묻는 자리가 죄다 뜨거운
 * 길목이다: 새 블록을 알릴 때마다(P2P), /info 와 /metrics 를 긁을 때마다,
 * getblock 을 부를 때마다. 10만 블록이면 한 번에 30ms 씩 들고, 거래소가
 * 블록을 하나씩 훑으며 getblock 을 부르면 그게 제곱이 된다.
 *
 * 뒤에 붙는 블록은 이어서 채우고, 체인이 갈리면 갈라진 지점부터 버린다.
 * (앞부분은 두 체인이 같은 블록이므로 다시 셀 필요가 없다.)
 */
let cumulativeWork = [];

// height 부터는 다른 블록이 됐다 — 그 뒤 캐시를 버린다
const dropWorkFrom = height => {
  if (cumulativeWork.length > height) {
    cumulativeWork.length = Math.max(0, height);
  }
};

// 0..height 까지 우리 체인이 한 일. height 가 팁보다 크면 팁까지.
const workUpTo = height => {
  const last = Math.min(height, blockchain.length - 1);
  if (last < 0) {
    return 0n;
  }
  for (let i = cumulativeWork.length; i <= last; i++) {
    cumulativeWork[i] = (i === 0 ? 0n : cumulativeWork[i - 1]) + Target.workOf(blockchain[i].bits);
  }
  return cumulativeWork[last];
};

const tipWork = () => workUpTo(blockchain.length - 1);
// 블록체인 재배치
const replaceChain = candidateChain => {
  const validated = isChainValid(candidateChain);
  if (validated === null) {
    return false;
  }
  const { common } = validated;

  /*
   * 무게는 갈라진 지점 뒤만 견준다.
   *
   * 앞부분은 두 체인이 같은 블록이므로 더해 봐야 양쪽에서 지워진다. 전부
   * 더하면 replaceChain 한 번에 체인 길이만큼 256비트 나눗셈을 하게 되고,
   * 그건 지는 갈래를 계속 들이미는 피어에게 좋은 먹잇감이다.
   *
   * 앞부분을 *우리* 블록으로 재는 것은 그대로다 — 상대가 그 자리의 난이도를
   * 부풀려 보내도 소용없다(isChainValid 가 우리 블록으로 채워 준다).
   */
  const ourWork = chainWork(blockchain.slice(common));
  const theirWork = chainWork(validated.chain.slice(common));
  if (theirWork <= ourWork) {
    return false;
  }

  /*
   * 되돌려지는 블록에 담겼던 트랜잭션은 아직 유효할 수 있다. 예전에는
   * 그대로 사라져 버렸다. 갈라진 지점 뒤만 보면 된다 — 앞부분은 두 체인에
   * 모두 있으므로 고아가 될 수 없다.
   */
  const orphaned = collectOrphanedTxs(blockchain.slice(common), validated.chain.slice(common));

  /*
   * 색인을 먼저 되감는다.
   *
   * 헤더 기록의 data 는 "그 높이의 본문"을 읽는 getter 다. 체인을 갈아
   * 끼우고 나면 같은 높이에 새 블록이 앉으므로, 나중에 읽으면 새 블록의
   * 본문이 나온다 — 색인에서 지울 트랜잭션을 엉뚱하게 고르게 된다.
   * 아직 옛 체인이 살아 있는 지금 해 두면 본문을 복사해 둘 필요가 없다.
   */
  if (common < blockchain.length) {
    AddressIndex.rollbackTo(blockchain[common].index);
    ChainIndex.rollbackBlocks(blockchain.slice(common));
  }

  /*
   * 새 블록의 본문을 손에 쥔다.
   *
   * 뒤에서 파일을 자를 것이므로, 자른 뒤에는 디스크에서 읽을 수 없다.
   * 후보 배열에 우리 헤더 기록이 섞여 있어도(부르는 쪽이 그렇게 만들 수
   * 있다) 여기서 값으로 굳으므로 안전하다.
   */
  const appended = validated.chain.slice(common).map(block => ({ ...block }));

  /*
   * 저장소는 갈라진 지점에서 잘라 내고 새 블록만 이어 붙인다. 예전에는
   * 파일을 통째로 다시 썼다 — 한두 블록 갈라지자고 만 블록을 다시 쓰는
   * 셈이었다.
   *
   * 디스크가 말을 듣지 않으면(공간 부족 등) 메모리와 파일이 어긋난 채로
   * 남는다. 그때는 파일을 진실로 삼아 다시 읽어 들인다 — 그러지 않으면
   * 노드는 디스크에 없는 체인을 계속 내주게 된다.
   */
  try {
    Store.truncateBlocksTo(common);
    // 잘라 낸 자리 위의 본문 캐시도 함께 버린다 (없는 블록의 본문이다)
    for (const height of [...bodyCache.keys()]) {
      if (height >= common) {
        bodyCache.delete(height);
      }
    }
    for (const block of appended) {
      Store.appendBlock(block);
    }
  } catch (e) {
    console.log(`체인을 저장하지 못했습니다: ${e.message}. 저장된 체인으로 되돌립니다.`);
    Store.dropChainstate();
    initChain(Store.currentDir());
    return false;
  }

  /*
   * 갈라진 지점 앞은 이미 들고 있던 헤더 기록 그대로다. 전체를 다시 감싸면
   * 되감기 값이 갈라진 깊이가 아니라 체인 길이에 비례하게 된다 — undo
   * 데이터를 둔 이유가 사라진다. 새 블록만 감싼다.
   */
  blockchain = validated.chain.slice(0, common).concat(toHeaderChain(appended, common));
  dropWorkFrom(common);
  uTxOuts = validated.uTxOuts;
  undoLog = validated.undo;
  trimUndoLog();

  let indexed = validated.uTxOutsAtCommon;
  for (let i = common; i < blockchain.length; i++) {
    AddressIndex.applyBlock(blockchain[i], indexed);
    ChainIndex.applyBlock(blockchain[i]);
    // 서명 검증은 isChainValid 에서 끝났으므로 여기서는 반영만 한다
    indexed = updateUTxOuts(blockchain[i].data, indexed, blockchain[i].index);
  }

  /*
   * 갈아 끼운 체인의 스냅샷을 남긴다. 버리기만 하면, 다음 스냅샷(500블록마다)
   * 전에 노드가 갑자기 죽었을 때 제네시스부터 전부 다시 검증하게 된다.
   */
  persistChainstate();

  updateMempool(uTxOuts);
  reinstateTxs(orphaned);
  require('./p2p').broadcastNewBlock();
  return true;
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
      addToMempool(tx, snapshot, nextHeight(), tipMedianTime());
      restored++;
    } catch {
      // 이미 다른 트랜잭션이 같은 UTxO 를 썼거나 유효하지 않게 된 경우
    }
  }
  if (restored > 0) {
    console.log(`체인 교체로 밀려난 트랜잭션 ${restored}건을 mempool 로 되돌렸습니다`);
  }
};

/*
 * 저장해 둔 mempool 을 되살린다.
 *
 * 그동안 블록에 담겼거나 다른 트랜잭션이 같은 UTxO 를 써 버렸을 수 있으므로
 * 그대로 믿지 않고 다시 검증한다. 떨어지는 것은 그냥 버린다 —
 * 비트코인 코어가 LoadMempool 에서 하는 것과 같다.
 */
const restoreMempool = () => {
  const saved = Store.loadMempool();
  if (saved.length === 0) {
    return 0;
  }
  const snapshot = getUTxOutList();
  let restored = 0;
  for (const tx of saved) {
    try {
      addToMempool(tx, snapshot, nextHeight(), tipMedianTime());
      restored++;
    } catch {
      // 이미 담겼거나 더는 유효하지 않다
    }
  }
  console.log(
    `저장된 mempool 에서 ${restored}건을 되살렸습니다 (저장돼 있던 것 ${saved.length}건)`
  );
  return restored;
};

// 지금 mempool 을 파일에 남긴다. 종료할 때, 그리고 바뀐 뒤 잠시 후에 부른다.
const persistMempool = () => Store.saveMempool(getMempool());

/*
 * mempool 이 바뀌면 몇 초 뒤 저장한다.
 *
 * 종료 신호에서만 저장하면 kill -9 나 정전에 그 사이의 것을 다 잃는다.
 * 바뀔 때마다 바로 쓰면 트랜잭션 한 건에 파일 하나를 통째로 다시 쓰게
 * 되므로, 잠깐 모아서 쓴다. 잃어도 마지막 몇 초 분량이다.
 *
 * 저장소가 열려 있지 않으면(테스트) saveMempool 이 알아서 무시한다.
 * 타이머는 unref 해 두어 프로세스를 붙잡지 않게 한다.
 */
const MEMPOOL_SAVE_DELAY = 3000;
let mempoolSaveTimer = null;
const scheduleMempoolSave = () => {
  if (mempoolSaveTimer !== null || !Store.isOpen()) {
    return;
  }
  mempoolSaveTimer = setTimeout(() => {
    mempoolSaveTimer = null;
    persistMempool();
  }, MEMPOOL_SAVE_DELAY);
  mempoolSaveTimer.unref();
};
Mempool.onChange(scheduleMempoolSave);

// 블록 체인 더하기
const addBlockToChain = candidateBlock => {
  if(isBlockValid(candidateBlock, getBlockChain())){
    const processedTxs = processTxs(
      candidateBlock.data,
      uTxOuts,
      candidateBlock.index,
      // 시각 기반 lockTime 은 내 시계가 아니라 직전 11블록의 중앙값과 견준다
      medianTimePast(blockchain)
    );
    if(processedTxs === null){
      console.log("Couldnt process txs");
      return false;
    }else{
        // 주소 색인은 이 블록 이전의 UTxOut 으로 입력을 되짚어야 하므로
        // uTxOuts 를 갈아 끼우기 전에 먼저 갱신한다.
        AddressIndex.applyBlock(candidateBlock, uTxOuts);
        ChainIndex.applyBlock(candidateBlock);
        cacheBody(blockchain.length, candidateBlock.data);
        blockchain.push(headerRecordOf(candidateBlock, blockchain.length));
        undoLog.push(collectConsumed(candidateBlock.data, uTxOuts));
        trimUndoLog();
        uTxOuts = processedTxs;
        updateMempool(uTxOuts);
        Store.appendBlock(candidateBlock);
        // 가끔 스냅샷을 남겨 다음에 뜰 때 전부 재생하지 않게 한다
        if (candidateBlock.index % SNAPSHOT_INTERVAL === 0) {
          persistChainstate();
        }
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
/*
 * 메모리 상태를 제네시스만 있는 상태로 되돌린다.
 *
 * 데이터 디렉터리가 비어 있거나 제네시스가 바뀌었을 때 부른다. 예전에는
 * 이때 아무것도 되돌리지 않고 그냥 돌아갔다 — 이미 체인을 들고 있던
 * 프로세스가 빈 디렉터리로 다시 뜨면 메모리와 디스크가 어긋난 채로 돌았다.
 */
const resetToGenesis = () => {
  bodyCache.clear();
  blockchain = toHeaderChain([genesisBlock]);
  cumulativeWork = [];
  uTxOuts = processTxs(genesisBlock.data, [], 0, 0);
  undoLog = [collectConsumed(genesisBlock.data, [])];
  rebuildIndexes();
};

const initChain = (dataDir) => {
  Store.open(dataDir);
  bodyCache.clear();
  AddressIndex.reset();
  ChainIndex.reset();

  /*
   * 저장된 체인을 한 번만 훑는다.
   *
   * 예전에는 파일을 통째로 배열에 올린 뒤(체인 크기만큼 메모리) 검증하고,
   * 그러고도 색인을 만들려고 한 번 더 훑었다. 이제 한 줄씩 읽으면서 그
   * 자리에서 반영하고 본문은 흘려보낸다 — 메모리에 남는 것은 헤더뿐이다.
   *
   * 스냅샷이 저장된 체인의 끝과 맞으면 서명 검증을 건너뛴다. 이미 우리가
   * 받아들여 적어 둔 블록들이고, 서명 검증이 시작 비용의 대부분이다.
   * UTxOut 집합과 색인은 어차피 다시 쌓아야 하므로(주소 색인은 입력이
   * 가리키는 이전 출력을 되짚어야 한다) 그 부분은 늘 재생한다.
   */
  const snapshot = Store.loadChainstate();
  /*
   * 스냅샷이 가리키는 높이까지는 검증을 건너뛴다. 그 높이의 해시가 스냅샷과
   * 같은지 그 자리에서 확인하고, 다르면 스냅샷을 버리고 처음부터 다시 한다.
   * 스냅샷 뒤에 더 붙은 블록(스냅샷을 남기기 전에 죽은 경우)은 검증한다.
   */
  const skipUntil = snapshot !== null && typeof snapshot.tipHash === "string" ? snapshot.height : -1;
  const headers = [];
  let utxos = [];
  let undo = [];
  let stoppedAt = null;
  let genesisMismatch = false;
  let staleSnapshot = false;
  let skipped = 0;

  const scanned = Store.scanBlocks((block, height) => {
    if (stoppedAt !== null || staleSnapshot) {
      return;
    }
    const trusted = height <= skipUntil;
    if (trusted && height === skipUntil && block.hash !== snapshot.tipHash) {
      staleSnapshot = true;
      return;
    }
    if (height === 0) {
      if (block.hash !== genesisBlock.hash || getMerkleRoot(block.data) !== genesisBlock.merkleRoot) {
        genesisMismatch = true;
        stoppedAt = 0;
        return;
      }
    } else if (!trusted && !isBlockValid(block, headers)) {
      console.log(`저장된 블록 #${block.index} 이 유효하지 않습니다. 여기까지만 복원합니다.`);
      stoppedAt = height;
      return;
    }
    if (trusted) {
      skipped++;
    }

    const consumed = collectConsumed(block.data, utxos);
    const processed = trusted
      ? updateUTxOuts(block.data, utxos, block.index)
      : processTxs(block.data, utxos, block.index, medianTimePast(headers));
    if (processed === null) {
      console.log(`저장된 블록 #${block.index} 의 트랜잭션을 처리할 수 없습니다. 여기까지만 복원합니다.`);
      stoppedAt = height;
      return;
    }
    // 주소 색인은 이 블록 이전의 UTxOut 으로 입력을 되짚는다
    AddressIndex.applyBlock(block, utxos);
    ChainIndex.applyBlock(block);
    headers.push(headerRecordOf(block, height));
    undo.push(consumed);
    utxos = processed;
  });

  if (scanned === 0) {
    // 처음 뜨는 노드. 제네시스만 저장해 둔다.
    resetToGenesis();
    Store.appendBlock(genesisBlock);
    return { restored: 0, height: 0, fromSnapshot: false };
  }

  if (genesisMismatch) {
    // genesis.json 을 새로 만들었는데 옛 체인이 남아 있는 경우
    console.log(
      "저장된 체인의 제네시스가 지금 genesis.json 과 다릅니다. 저장본을 버리고 새로 시작합니다."
    );
    Store.writeBlocks([genesisBlock]);
    resetToGenesis();
    // 저 체인에 속하던 mempool 도 함께 버린다
    Store.saveMempool([]);
    Store.dropChainstate();
    return { restored: 0, height: 0, fromSnapshot: false };
  }

  if (staleSnapshot) {
    // 스냅샷이 이 체인의 것이 아니었다. 버리고 처음부터 다시 한다.
    console.log("스냅샷이 저장된 체인과 맞지 않습니다. 전부 재생합니다.");
    Store.dropChainstate();
    return initChain(dataDir);
  }

  const tip = headers[headers.length - 1];

  blockchain = headers;
  cumulativeWork = [];
  uTxOuts = utxos;
  undoLog = undo;
  trimUndoLog();

  // 중간에 잘렸다면 파일도 맞춰 준다
  if (stoppedAt !== null) {
    Store.truncateBlocksTo(headers.length);
    Store.dropChainstate();
  }
  restoreMempool();
  persistChainstate();

  return {
    restored: headers.length,
    height: tip.index,
    fromSnapshot: skipped > 0,
    verified: headers.length - skipped
  };
};

/*
 * UTxOut 집합을 스냅샷으로 남긴다. 뜰 때 이것이 있으면 전부 재생하지 않는다.
 * undo 는 되감을 수 있는 깊이만큼만 남긴다 — 전부 두면 파일이 체인만큼 커진다.
 */
const persistChainstate = () => {
  if (blockchain.length === 0) {
    return;
  }
  const tip = blockchain[blockchain.length - 1];
  Store.saveChainstate({
    version: 1,
    height: blockchain.length - 1,
    tipHash: tip.hash,
    uTxOuts,
    undo: undoLog.slice(-KEEP_UNDO)
  });
};

/*
 * 색인을 다시 만든다.
 *
 * 블록은 받아들일 때 이미 검증했으므로 여기서는 반영만 한다 — 예전에는
 * processTxs 를 불러 서명을 전부 다시 확인했다. 색인을 다시 만드는 데
 * 체인을 통째로 재검증할 이유가 없다.
 */
const rebuildIndexes = () => {
  AddressIndex.rebuild(blockchain, (block, before) =>
    updateUTxOuts(block.data, before, block.index)
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

/*
 * 잔액 상위 주소 (리치리스트).
 *
 * UTxOut 집합을 주소로 묶으면 나온다. 다만 이건 체인 길이가 아니라 **미사용
 * 출력 수**에 비례하는 일이라, 블록마다 부르면 아깝다. 팁이 그대로면 답도
 * 그대로이므로 팁 해시를 열쇠로 캐시한다.
 *
 * 한 가지 분명히 해 둘 것: 이건 "부자 순위"가 아니라 **주소 순위**다.
 * 한 사람이 주소를 여럿 가질 수 있고(HD 지갑은 기본이 그렇다), 거래소는
 * 수많은 사람의 돈을 주소 몇 개에 모아 둔다. 그 둘을 구별할 방법은 체인에 없다.
 */
let richCache = { tip: null, rows: [] };

const getRichList = (limit = 50) => {
  const tip = blockchain[blockchain.length - 1].hash;
  if (richCache.tip !== tip) {
    const byAddress = new Map();
    for (const uTxOut of uTxOuts) {
      const seen = byAddress.get(uTxOut.address);
      if (seen === undefined) {
        byAddress.set(uTxOut.address, { address: uTxOut.address, balance: uTxOut.amount, outputs: 1 });
      } else {
        seen.balance += uTxOut.amount;
        seen.outputs++;
      }
    }
    richCache = {
      tip,
      rows: [...byAddress.values()].sort((a, b) => b.balance - a.balance)
    };
  }
  return {
    total: richCache.rows.length,
    /*
     * 캐시에 든 객체를 그대로 넘기지 않고 복사해서 준다. 부르는 쪽에서
     * 한 줄만 고쳐도 다음 사람이 받는 값이 조용히 바뀌기 때문이다.
     * limit 는 500 이하라 복사값이 캐시의 뜻을 지우지 않는다.
     */
    rows: richCache.rows
      .slice(0, Math.max(0, limit))
      .map(row => ({ address: row.address, balance: row.balance, outputs: row.outputs }))
  };
};

/*
 * 최근 블록의 시계열 — 난이도, 블록 사이 시간, 트랜잭션 수.
 *
 * 헤더만 훑으므로 디스크를 치지 않는다. 차트가 필요로 하는 것은 이 셋이다.
 * txCount 가 null 인 블록은 예전 형식으로 저장된 것이다(본문을 읽어야 안다).
 */
const getBlockSeries = (limit = 200) => {
  const count = Math.max(1, Math.min(limit, blockchain.length));
  const from = blockchain.length - count;
  return blockchain.slice(from).map((block, at) => {
    const previous = from + at > 0 ? blockchain[from + at - 1] : null;
    return {
      height: block.index,
      timestamp: block.timestamp,
      bits: block.bits,
      difficulty: Target.difficultyOf(block.bits),
      // 제네시스는 앞이 없다
      solveTime: previous === null ? null : block.timestamp - previous.timestamp,
      txCount: typeof block.txCount === "number" ? block.txCount : null
    };
  });
};

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
const sendTx = (address, amount, fee = 0, feeRate = 0) => {
  const confirmed = getUTxOutList();
  let tx;
  try {
    tx = createTx(
      address,
      amount,
      // 아직 묻히지 않은 코인베이스는 고르지 않는다. 골라 봐야 검증에서 떨어진다.
      getMatureUTxOuts(getSpendableUTxOuts(confirmed), nextHeight()),
      getMempool(),
      fee,
      feeRate
    );
  } catch (e) {
    /*
     * 돈이 없는 것과 "있는데 아직 못 쓰는 것"은 다르다. 채굴 보상이
     * 묻히기를 기다리는 중이라면 그렇다고 말해 줘야 한다 — 잔액이
     * 보이는데 "Not enough funds" 만 나오면 고장으로 보인다.
     */
    const immature = getImmatureBalance();
    if (immature > 0) {
      throw Error(
        `${e.message} — 채굴 보상 ${immature} 은 아직 쓸 수 없습니다. ` +
          `코인베이스 출력은 ${COINBASE_MATURITY}블록이 쌓여야 합니다.`
      );
    }
    throw e;
  }
  addToMempool(tx, confirmed, nextHeight(), tipMedianTime());
  require("./p2p").broadcastTx(tx);
  return tx;
};

/*
 * 밖에서 만들어 서명한 트랜잭션을 받는다 (거래소, 하드웨어 지갑, 다른 언어 지갑).
 *
 * 이 노드의 지갑과는 무관하다. 검증은 피어가 보낸 트랜잭션과 똑같이 한다 —
 * id 가 내용과 맞는지, 입력이 있는지, 서명이 맞는지, 성숙했는지. 통과하면
 * mempool 에 넣고 피어에게 알린다. 실패하면 이유를 던진다(피어 것은 조용히
 * 버리지만 직접 보낸 사람에게는 왜 안 되는지 말해 줘야 한다).
 */
const submitTx = tx => {
  if (tx === null || typeof tx !== "object" || !Array.isArray(tx.txIns) || !Array.isArray(tx.txOuts)) {
    throw Error("트랜잭션 모양이 아닙니다 ({ id, txIns, txOuts })");
  }
  let expectedId;
  try {
    expectedId = Transactions.getTxId(tx);
  } catch (e) {
    throw Error(`직렬화할 수 없습니다: ${e.message}`);
  }
  if (tx.id !== expectedId) {
    throw Error(`id 가 내용과 맞지 않습니다 (계산값 ${expectedId})`);
  }
  addToMempool(tx, getUTxOutList(), nextHeight(), tipMedianTime());
  require("./p2p").broadcastTx(tx);
  return { id: tx.id, pending: true };
};

// mempool 과 코인베이스 성숙도까지 반영해 지금 실제로 보낼 수 있는 금액
const getSpendableBalance = () =>
  getWalletBalance(getMatureUTxOuts(getSpendableUTxOuts(uTxOuts), nextHeight()));

// 아직 묻히지 않아 쓸 수 없는 채굴 보상
const getImmatureBalance = () =>
  getWalletBalance(uTxOuts.filter(uTxOut => !isSpendable(uTxOut, nextHeight())));

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
      addToMempool(tx, snapshot, nextHeight(), tipMedianTime());
    } catch (e) {
      console.log(`피어가 보낸 트랜잭션을 받지 못했습니다: ${e.message}`);
    }
  }
};

module.exports = {
  replaceChain,
  countCommonPrefix,
  stopMiners,
  // 테스트용 — 채굴 워커를 직접 다룬다
  findBlockInWorkers,
  getMinerPool: getPool,
  initChain,
  persistMempool,
  persistChainstate,
  rebuildIndexes,
  MAX_REORG_DEPTH,
  getTxProof,
  getBlockByHash,
  getBlockByHeight,
  findTx,
  bitsForNext,
  findBits,
  BLOCK_VERSION,
  BlOCK_GENERATION_INTERVAL,
  medianTimePast,
  MEDIAN_TIME_SPAN,
  MAX_FUTURE_BLOCK_TIME,
  isBlockValid,
  isHeaderValid,
  isHeaderStructureValid,
  headerOf,
  chainWork,
  tipWork,
  workUpTo,
  addBlockToChain,
  isBlockStructureValid,
  getNewestBlock,
  getBlockChain,
  createNewBlock,
  getAccountBalance,
  getSpendableBalance,
  getImmatureBalance,
  nextHeight,
  sendTx,
  handleIncomingTxs,
  getUTxOutList,
  getRichList,
  getBlockSeries,
  miningAddress,
  submitTx
};
