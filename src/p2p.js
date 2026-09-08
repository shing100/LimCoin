const WebSockets = require('ws'),
  Blockchain = require('./blockchain'),
  Mempool = require("./memPool");

const { getNewestBlock, isBlockStructureValid, replaceChain, getBlockChain, addBlockToChain, handleIncomingTxs } = Blockchain;

const { getMempool } = Mempool;
const sockets = [];
const KEEP_ALIVE_INTERVAL = 30000;

// 피어 수와 메시지 크기에 상한을 둔다.
// 예전에는 둘 다 없어서, 아무나 연결을 무한히 열거나 거대한 메시지 하나로
// 노드의 메모리를 밀어낼 수 있었다.
const MAX_PEERS = 32;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

// 이미 붙은 피어에 또 연결하지 않도록 주소를 기억한다.
// 예전에는 같은 피어에 connectToPeers 를 여러 번 부르면 소켓이 계속 쌓였다.
const dialedPeers = new Set();

// Message Type
const GET_LATEST = "GET_LATEST";
const GET_ALL = "GET_ALL";
const BLOCKCHAIN_RESPONSE = "BLOCKCHAIN_RESPONSE";
const REQUEST_MEMPOOL = "REQUEST_MEMPOOL";
const MEMPOOL_RESPONSE = "MEMPOOL_RESPONSE";

// Message Creators
const getLatest = () => {
  return {
    type: GET_LATEST,
    data: null
  };
};

const getAll = () => {
  return {
    type: GET_ALL,
    data: null
  };
};

const blockchainResponse = (data) => {
  return {
    type: BLOCKCHAIN_RESPONSE,
    data
  }
}

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
      case GET_ALL:
        sendMessage(ws, responseAll());  // 모든
        break;
      case BLOCKCHAIN_RESPONSE:
        if(!Array.isArray(message.data)){
          console.log("BLOCKCHAIN_RESPONSE 의 본문이 블록 배열이 아닙니다");
          break;
        }
        handleBlockchainResponse(message.data);
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

// 블록체인응답 핸들러
const handleBlockchainResponse = receivedBlocks => {
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
  // 가져온 블록과 기존 블록 비교
  if(latestBlockReceived.index > newestBlock.index){
    if(newestBlock.hash === latestBlockReceived.previousHash){
      if(addBlockToChain(latestBlockReceived)) {
        broadcastNewBlock();
      }
    }else if(receivedBlocks.length === 1){
      sendMessageToAll(getAll());
    }else{
      replaceChain(receivedBlocks);
    }
  }
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
// 모든 블록체인 가져오기
const responseAll = () => blockchainResponse(getBlockChain());
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

const connectToPeers = newPeer => {
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
  startP2PServer,
  connectToPeers,
  getPeers,
  broadcastNewBlock,
  broadcastMempool
};
