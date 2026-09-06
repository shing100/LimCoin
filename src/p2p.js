const WebSockets = require('ws'),
  Blockchain = require('./blockchain'),
  Mempool = require("./memPool");

const { getNewestBlock, isBlockStructureValid, replaceChain, getBlockChain, addBlockToChain, handleIncomingTx } = Blockchain;

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
    console.log(e);
    return null;
  }
}

// 소켓 핸들러
const handleSocketMessages = ws => {
  ws.on("message", data => {
    const message = parseData(data);
    if(message === null){
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
        const receivedBlocks = message.data;
        if(receivedBlocks == null){
          break;
        }
        handleBlockchainResponse(receivedBlocks);
        break;
      case REQUEST_MEMPOOL:
        sendMessage(ws, returnMempool());
        break;
      case MEMPOOL_RESPONSE:
        const receivedTxs = message.data;
        if(!(receivedTxs instanceof Array)){
          return;
        }
        receivedTxs.forEach(tx => {
          try{
            handleIncomingTx(tx);
          }catch(e){
            console.log(e);
          }
        })
        break;
    }
  });
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
  startP2PServer,
  connectToPeers,
  getPeers,
  broadcastNewBlock,
  broadcastMempool
};
