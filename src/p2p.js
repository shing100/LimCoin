const WebSockets = require('ws'),
  Blockchain = require('./blockchain'),
  Mempool = require("./memPool"),
  ChainIndex = require("./chainIndex");

const {
  getNewestBlock, isBlockStructureValid, replaceChain, getBlockChain,
  addBlockToChain, handleIncomingTxs
} = Blockchain;

const { getMempool } = Mempool;
const sockets = [];
const KEEP_ALIVE_INTERVAL = 30000;

// 피어 수와 메시지 크기에 상한을 둔다.
// 예전에는 둘 다 없어서, 아무나 연결을 무한히 열거나 거대한 메시지 하나로
// 노드의 메모리를 밀어낼 수 있었다.
const MAX_PEERS = 32;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/*
 * 체인 동기화는 조각으로 한다.
 *
 * 예전에는 뒤처진 노드가 GET_ALL 을 보내면 상대가 체인 전체를 한 메시지에
 * 담아 보냈다. 메시지 상한이 8MB 이므로 체인이 그보다 커지는 순간 새 노드는
 * 동기화 자체를 못 하게 된다 — 상한을 없애면 그 한 메시지가 메모리를 밀어낸다.
 *
 * 비트코인처럼 한다. 뒤처진 쪽이 자기 체인의 해시 몇 개(locator)를 보내면,
 * 상대는 그중 자기도 아는 첫 해시를 찾아 그 다음 블록부터 한 묶음을 준다.
 * 다 받을 때까지 반복한다.
 *
 *   - 우리 끝에 그대로 이어지는 묶음은 하나씩 바로 붙인다 (보통의 경우,
 *     그리고 새 노드가 제네시스부터 받는 경우). 메모리를 쌓지 않는다.
 *   - 갈라진 지점부터 오는 묶음은 다 받은 뒤 한 번에 갈아 끼운다. 조각마다
 *     갈아 끼우려 하면 아직 무게가 모자라 거부될 수 있기 때문이다. 갈라지는
 *     깊이는 보통 한두 블록이라 쌓이는 양이 작다.
 */
const MAX_BLOCKS_PER_BATCH = 500;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
// 갈라진 체인을 다 받을 때까지 쌓아 두는 상한. 피어가 끝없이 보내면 버린다.
const MAX_SYNC_BUFFER = 20000;
// 요청해 놓고 이만큼 응답이 없으면 다시 요청할 수 있게 한다
const SYNC_REQUEST_TIMEOUT = 30000;

// 이미 붙은 피어에 또 연결하지 않도록 주소를 기억한다.
// 예전에는 같은 피어에 connectToPeers 를 여러 번 부르면 소켓이 계속 쌓였다.
const dialedPeers = new Set();

// Message Type
const GET_LATEST = "GET_LATEST";
const GET_BLOCKS = "GET_BLOCKS";
const BLOCKCHAIN_RESPONSE = "BLOCKCHAIN_RESPONSE";
const BLOCKS_RESPONSE = "BLOCKS_RESPONSE";
const REQUEST_MEMPOOL = "REQUEST_MEMPOOL";
const MEMPOOL_RESPONSE = "MEMPOOL_RESPONSE";

// Message Creators
const getLatest = () => {
  return {
    type: GET_LATEST,
    data: null
  };
};

// "이 해시들 중 네가 아는 첫 것 다음부터 보내 줘"
const getBlocks = locator => {
  return {
    type: GET_BLOCKS,
    data: { locator }
  };
};

const blockchainResponse = (data) => {
  return {
    type: BLOCKCHAIN_RESPONSE,
    data
  }
}

const blocksResponse = (blocks, height) => {
  return {
    type: BLOCKS_RESPONSE,
    data: { blocks, height }
  };
};

const getAllMempool = () => {
  return {
    type: REQUEST_MEMPOOL,
    data: null
  };
};

const mempoolResponse = data => {
  return {
    type: MEMPOOL_RESPONSE,
    data
  };
};

// 소켓 가져오기
const getSockets = () => sockets;

// 서버 시작하기
const startP2PServer = server => {
  const wsServer = new WebSockets.Server({ server, maxPayload: MAX_MESSAGE_BYTES });
  wsServer.on("connection", ws => {
    if (sockets.length >= MAX_PEERS) {
      console.log(`피어 수 상한(${MAX_PEERS})에 걸려 연결을 거절했습니다`);
      ws.close();
      return;
    }
    initSocketConnection(ws);
  });
  wsServer.on("error", () => {
    console.log("error");
  })
  console.log("LimCoin P2P Server Running!");
};

// 웹 소켓 연결하기
const initSocketConnection = ws => {
  sockets.push(ws);
  handleSocketMessages(ws);
  handleSocketError(ws);
  sendMessage(ws, getLatest());
  // 새로 붙은 피어에게만 mempool 을 요청한다
  setTimeout(() => {
    sendMessage(ws, getAllMempool());
  }, 1000);
  // keepalive. 소켓이 닫히면 handleSocketError 에서 해제한다
  ws.keepAliveId = setInterval(() => {
    if (ws.readyState === WebSockets.OPEN) {
      ws.ping();
    }
  }, KEEP_ALIVE_INTERVAL);
};

// 데이터 JSON 변환
const parseData = data => {
  try {
    return JSON.parse(data);
  } catch(e) {
    // 남이 보낸 것이 깨져 있는 것뿐이다. 스택을 뱉을 일이 아니다.
    console.log("피어가 보낸 메시지가 JSON 이 아닙니다");
    return null;
  }
}

/*
 * 피어가 보낸 메시지를 처리한다.
 *
 * 여기 들어오는 것은 전부 남이 보낸 바이트다. 예전에는 그것을 믿고
 * 그대로 썼다. BLOCKCHAIN_RESPONSE 의 data 가 배열인지 보지 않아서
 *
 *   {"type":"BLOCKCHAIN_RESPONSE","data":123}
 *
 * 한 줄이면 노드가 죽었다 — 123[NaN] 이 undefined 가 되고 그것의
 * .index 를 읽다가 TypeError 가 난다. ws 의 message 핸들러에서 던진
 * 예외는 아무도 받지 않으므로 프로세스가 그대로 종료된다. 아무나
 * P2P 포트에 붙어 한 번 보내면 그 노드는 내려간다.
 *
 * 두 겹으로 막는다. 모양을 먼저 보고, 그래도 남는 것은 try 로 가둔다.
 * 한 피어가 보낸 것이 노드를 죽여서는 안 된다.
 */
const handleSocketMessages = ws => {
  ws.on("message", data => {
    try {
      handleMessage(ws, parseData(data));
    } catch (e) {
      console.log(`피어가 보낸 메시지를 처리하다 실패했습니다: ${e.message}`);
    }
  });
};

const handleMessage = (ws, message) => {
    if(message === null || typeof message !== "object"){
      return;
    }
    switch (message.type) {
      case GET_LATEST:
        sendMessage(ws, responseLatest());  // 가장 최근
        break;
      case GET_BLOCKS:
        if(message.data === null || typeof message.data !== "object"){
          break;
        }
        sendMessage(ws, responseBlocks(message.data.locator));
        break;
      case BLOCKCHAIN_RESPONSE:
        if(!Array.isArray(message.data)){
          console.log("BLOCKCHAIN_RESPONSE 의 본문이 블록 배열이 아닙니다");
          break;
        }
        handleBlockchainResponse(ws, message.data);
        break;
      case BLOCKS_RESPONSE:
        if(message.data === null || typeof message.data !== "object"){
          break;
        }
        handleBlocksResponse(ws, message.data);
        break;
      case REQUEST_MEMPOOL:
        sendMessage(ws, returnMempool());
        break;
      case MEMPOOL_RESPONSE:
        if(!Array.isArray(message.data)){
          break;
        }
        // 낱개로 넣으면 트랜잭션마다 UTxOut 집합을 복제하게 된다
        handleIncomingTxs(message.data);
        break;
    }
};

const returnMempool = () => mempoolResponse(getMempool());

/*
 * 새 블록 소식 (한 블록).
 *
 * 우리 끝에 그대로 이어지면 붙이고 다른 피어에게도 알린다.
 * 그보다 앞서 있는데 이어지지 않으면 — 우리가 몇 블록 뒤처졌거나 체인이
 * 갈라진 것이다 — 그 피어에게 조각으로 달라고 한다.
 * 예전에는 이때 모든 피어에게 체인 전체를 달라고 했다.
 */
const handleBlockchainResponse = (ws, receivedBlocks) => {
  if(receivedBlocks.length === 0){
    console.log("Received blocks have a length of 0");
    return;
  }
  const latestBlockReceived = receivedBlocks[receivedBlocks.length -1];
  if(!isBlockStructureValid(latestBlockReceived)) {
    console.log("The block structure of the block received is not valid");
    return;
  }
  const newestBlock = getNewestBlock();
  if(latestBlockReceived.index > newestBlock.index){
    if(newestBlock.hash === latestBlockReceived.previousHash){
      if(addBlockToChain(latestBlockReceived)) {
        broadcastNewBlock();
      }
    }else{
      requestBlocks(ws);
    }
  }
};

/*
 * 우리 체인의 해시 몇 개. 상대가 공통 지점을 찾는 데 쓴다.
 *
 * 끝에서부터 열 개는 하나씩, 그 뒤로는 간격을 두 배씩 늘려 제네시스까지.
 * 얕은 갈래(보통의 경우)는 정확히 잡고, 깊은 갈래도 O(log n) 개로 덮는다.
 * 비트코인의 CBlockLocator 와 같다.
 *
 * 갈라진 체인을 받는 중이면 지금까지 받은 마지막 해시를 맨 앞에 둔다 —
 * 그래야 상대가 그 다음을 이어 준다. 우리 체인만 보내면 같은 묶음을
 * 다시 받게 된다.
 */
const buildLocator = sync => {
  const hashes = [];
  if (sync && sync.buffer.length > 0) {
    hashes.push(sync.buffer[sync.buffer.length - 1].hash);
  }
  const chain = getBlockChain();
  let step = 1;
  for (let height = chain.length - 1; height > 0; height -= step) {
    hashes.push(chain[height].hash);
    if (hashes.length >= 10) {
      step *= 2;
    }
  }
  hashes.push(chain[0].hash);
  return hashes;
};

const syncStateOf = ws => {
  if (!ws.sync) {
    ws.sync = { buffer: [], inFlight: false, requestedAt: 0, progressed: false };
  }
  return ws.sync;
};

const requestBlocks = ws => {
  const sync = syncStateOf(ws);
  if (sync.inFlight && Date.now() - sync.requestedAt < SYNC_REQUEST_TIMEOUT) {
    return; // 이미 달라고 해 놨다
  }
  sync.inFlight = true;
  sync.requestedAt = Date.now();
  sendMessage(ws, getBlocks(buildLocator(sync)));
};

/*
 * GET_BLOCKS 에 답한다. locator 중 우리도 아는 첫 해시 다음부터 한 묶음.
 * 개수와 크기 둘 다에 상한을 둔다 — 블록 하나가 트랜잭션 100건이면 60KB 쯤이라
 * 개수만 보면 4MB 를 훌쩍 넘을 수 있다.
 */
const responseBlocks = locator => {
  const chain = getBlockChain();
  let start = 0;
  if (Array.isArray(locator)) {
    for (const hash of locator) {
      if (typeof hash !== "string") {
        continue;
      }
      const height = ChainIndex.findBlockHeight(hash);
      if (height !== undefined) {
        start = height + 1;
        break;
      }
    }
  }

  const blocks = [];
  let bytes = 0;
  for (let i = start; i < chain.length && blocks.length < MAX_BLOCKS_PER_BATCH; i++) {
    const size = JSON.stringify(chain[i]).length;
    if (blocks.length > 0 && bytes + size > MAX_BATCH_BYTES) {
      break;
    }
    blocks.push(chain[i]);
    bytes += size;
  }
  return blocksResponse(blocks, chain.length - 1);
};

const resetSync = (ws, reason) => {
  const sync = syncStateOf(ws);
  if (reason) {
    console.log(`동기화를 중단합니다: ${reason}`);
  }
  sync.buffer = [];
  sync.inFlight = false;
  sync.progressed = false;
};

// 한 묶음 안에서 모양이 맞고 서로 이어지는지
const isBatchWellFormed = blocks =>
  blocks.every(
    (block, i) =>
      isBlockStructureValid(block) &&
      (i === 0 || block.previousHash === blocks[i - 1].hash)
  );

const handleBlocksResponse = (ws, data) => {
  const { blocks, height } = data;
  if (!Array.isArray(blocks)) {
    return;
  }
  const sync = syncStateOf(ws);
  sync.inFlight = false;

  if (blocks.length === 0) {
    finishSync(ws);
    return;
  }
  if (!isBatchWellFormed(blocks)) {
    resetSync(ws, "받은 묶음이 서로 이어지지 않습니다");
    return;
  }

  if (sync.buffer.length === 0 && blocks[0].previousHash === getNewestBlock().hash) {
    // 우리 끝에 그대로 이어진다. 하나씩 붙이고 쌓아 두지 않는다.
    for (const block of blocks) {
      if (!addBlockToChain(block)) {
        resetSync(ws, `블록 #${block.index} 이 검증에서 떨어졌습니다`);
        return;
      }
    }
    sync.progressed = true;
  } else {
    // 갈라진 지점부터 온다. 다 받은 뒤 한 번에 갈아 끼운다.
    const tail = sync.buffer.length > 0 ? sync.buffer[sync.buffer.length - 1].hash : null;
    if (tail === null) {
      if (ChainIndex.findBlockHeight(blocks[0].previousHash) === undefined) {
        resetSync(ws, "받은 묶음이 우리 체인 어디에도 붙지 않습니다");
        return;
      }
    } else if (blocks[0].previousHash !== tail) {
      resetSync(ws, "받은 묶음이 앞서 받은 것에 이어지지 않습니다");
      return;
    }
    if (sync.buffer.length + blocks.length > MAX_SYNC_BUFFER) {
      resetSync(ws, `갈라진 체인이 ${MAX_SYNC_BUFFER} 블록을 넘습니다`);
      return;
    }
    sync.buffer.push(...blocks);
  }

  const lastReceived = blocks[blocks.length - 1].index;
  if (typeof height === "number" && lastReceived >= height) {
    finishSync(ws);
    return;
  }
  requestBlocks(ws);
};

// 더 받을 것이 없다. 쌓아 둔 것이 있으면 갈아 끼우고, 바뀐 것이 있으면 알린다.
const finishSync = ws => {
  const sync = syncStateOf(ws);
  if (sync.buffer.length > 0) {
    const forkParent = ChainIndex.findBlockHeight(sync.buffer[0].previousHash);
    if (forkParent !== undefined) {
      const candidate = getBlockChain().slice(0, forkParent + 1).concat(sync.buffer);
      // replaceChain 이 성공하면 스스로 알린다
      if (!replaceChain(candidate)) {
        console.log(`받은 체인(${sync.buffer.length} 블록)이 우리 것보다 무겁지 않거나 유효하지 않습니다`);
      }
    }
    sync.buffer = [];
  }
  if (sync.progressed) {
    broadcastNewBlock();
  }
  sync.progressed = false;
  sync.inFlight = false;
};

// JSON 메세지 보내기 to WS
const sendMessage = (ws, message) => {
  if (ws.readyState !== WebSockets.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(message));
  } catch (e) {
    console.log(`Failed to send a message to a peer: ${e.message}`);
  }
};
// 모두에게 보내기
const sendMessageToAll = message => [...sockets].forEach(ws => sendMessage(ws, message));
// 최근 블록체인 가져오기
const responseLatest = () => blockchainResponse([getNewestBlock()]);
// 모두에게 블록 알리기
const broadcastNewBlock = () => sendMessageToAll(responseLatest());
// 맴풀 전달하기
const broadcastMempool = () => sendMessageToAll(returnMempool());

// 에러 체크
const handleSocketError = ws => {
  const closeSocketConnetion = ws => {
    clearInterval(ws.keepAliveId);
    if (ws.peerUrl) {
      dialedPeers.delete(ws.peerUrl);
    }
    ws.close();
    const index = sockets.indexOf(ws);
    if (index !== -1) {
      sockets.splice(index, 1);
    }
  };
  ws.on("error", () => closeSocketConnetion(ws));
  ws.on("close", () => closeSocketConnetion(ws));
};

/*
 * 피어 주소는 ws:// 나 wss:// 여야 한다.
 * 이 함수는 HTTP API 로도 불리므로 아무 문자열이나 들어올 수 있다.
 */
const isPeerUrl = url => {
  if (typeof url !== "string") {
    return false;
  }
  try {
    const { protocol } = new URL(url);
    return protocol === "ws:" || protocol === "wss:";
  } catch (e) {
    return false;
  }
};

const connectToPeers = newPeer => {
  if (!isPeerUrl(newPeer)) {
    throw Error("피어 주소는 ws:// 또는 wss:// 로 시작해야 합니다");
  }
  if (dialedPeers.has(newPeer)) {
    console.log(`이미 연결한 피어입니다: ${newPeer}`);
    return;
  }
  if (sockets.length >= MAX_PEERS) {
    throw Error(`피어 수 상한(${MAX_PEERS})에 도달했습니다`);
  }

  const ws = new WebSockets(newPeer, { maxPayload: MAX_MESSAGE_BYTES });
  dialedPeers.add(newPeer);
  ws.peerUrl = newPeer;

  ws.on("open", () => {
      initSocketConnection(ws);
  });
  ws.on("error", () => {
    console.log("Connection failed");
    dialedPeers.delete(newPeer);
  });
  ws.on("close", () => {
    console.log("Connection closed");
    dialedPeers.delete(newPeer);
  });
};

// 연결된 피어 주소 목록
const getPeers = () =>
  sockets.map(ws => {
    if (ws.peerUrl) {
      return ws.peerUrl;
    }
    const socket = ws._socket;
    return socket ? `${socket.remoteAddress}:${socket.remotePort}` : "unknown";
  });

module.exports = {
  // 테스트가 소켓 없이 메시지 처리를 부를 수 있게 열어 둔다
  handleMessage,
  buildLocator,
  MAX_BLOCKS_PER_BATCH,
  startP2PServer,
  connectToPeers,
  getPeers,
  broadcastNewBlock,
  broadcastMempool
};
