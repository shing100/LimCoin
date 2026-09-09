const WebSockets = require('ws'),
  Target = require("./target"),
  Blockchain = require('./blockchain'),
  Mempool = require("./memPool"),
  ChainIndex = require("./chainIndex"),
  Params = require("./params");

// 망 매직. 다른 망의 피어는 붙자마자 끊는다 — 테스트넷과 메인넷이 섞이면 안 된다.
const NETWORK_MAGIC = Params.current().magic;

const {
  getNewestBlock, isBlockStructureValid, replaceChain, getBlockChain,
  addBlockToChain, handleIncomingTxs, isHeaderValid, headerOf, chainWork
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

/*
 * 블록보다 헤더를 먼저 받는다 (headers-first).
 *
 * 예전에는 "상대 끝 블록의 높이가 우리보다 크면" 동기화를 시작했다. 그러면
 * 더 짧지만 더 무거운 체인(난이도가 높은)은 소식을 들어도 받지 않는다.
 * 체인을 고르는 기준은 높이가 아니라 일한 양(무게)이다 — 백서 4장.
 *
 * 헤더는 본문 없는 블록이라 300바이트쯤이다. 헤더만 먼저 받아 검증하고
 * (작업증명, 난이도, 타임스탬프, 연결) 무게를 잰 뒤, 우리 것보다 무거울
 * 때만 블록을 받는다. 무겁지 않은 체인에 블록을 내려받는 값을 쓰지 않고,
 * 받는 블록이 미리 받아 둔 헤더와 다르면 바로 알아본다.
 */
const MAX_HEADERS_PER_BATCH = 2000;
const MAX_HEADER_BUFFER = 200000;
/*
 * 헤더를 받는 동안 들고 있는 것은 셋뿐이다.
 *
 *   - 마지막 몇 개의 헤더 (창). 다음 헤더를 검증하는 데 필요한 것은
 *     난이도 계산(직전 10개)과 MTP(직전 11개)라 이만큼이면 된다.
 *   - 누적 무게
 *   - 받은 헤더의 해시 목록 (블록 단계에서 대조한다)
 *
 * 예전에는 갈라진 부분의 헤더 객체를 전부 배열로 들고 있었다. 새 노드가
 * 10만 블록을 받으면 헤더만 40MB 쯤이 쌓였다. 해시만 남기면 그 1/3 이다.
 */
/*
 * 헤더 검증에 필요한 앞선 블록 수. 목표값(LWMA 창 60 + 그 앞 하나)과
 * MTP(11)를 덮어야 한다.
 */
const HEADER_WINDOW = 64;

/*
 * 우리가 건 피어들. 주소 -> { attempts, timer }
 *
 * 이미 붙은 피어에 또 연결하지 않도록 기억한다 (예전에는 같은 피어에
 * connectToPeers 를 여러 번 부르면 소켓이 계속 쌓였다).
 *
 * 끊기면 다시 건다. 예전에는 한 번 끊기면 그걸로 끝이었다 — 상대가
 * 재시작하는 동안 우리는 조용히 혼자가 됐다. 상대가 죽어 있는 동안
 * 연결 시도로 도배하지 않도록 실패할 때마다 간격을 두 배로 늘린다.
 */
const dialedPeers = new Map();
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 60000;

/*
 * 피어 발견 (비트코인의 addr 교환).
 *
 * 지금까지는 피어 주소를 사람이 넣어 줘야 했다. 이제 붙으면 서로 자기
 * 공개 주소를 알리고(HELLO), 아는 피어 목록을 주고받는다(GET_PEERS).
 * 새로 알게 된 주소에는 outbound 상한까지 알아서 붙는다. 한 노드만 알고
 * 시작해도 그물이 이어진다.
 *
 * 공개 주소는 스스로 알 수 없다 (inbound 연결에서 보이는 것은 상대의
 * 임시 포트다). LIMCOIN_PUBLIC_URL 로 받는다. 없으면 남에게 자기를
 * 알리지 못할 뿐, 남의 주소를 배우는 것은 된다.
 */
const MAX_OUTBOUND = 8;
const MAX_KNOWN_ADDRESSES = 1000;
let publicUrl = null;              // ws://내주소:포트
const knownAddresses = new Set();  // 피어에게 배운 주소들

// Message Type
const GET_LATEST = "GET_LATEST";
const GET_HEADERS = "GET_HEADERS";
const GET_BLOCKS = "GET_BLOCKS";
const BLOCKCHAIN_RESPONSE = "BLOCKCHAIN_RESPONSE";
const HEADERS_RESPONSE = "HEADERS_RESPONSE";
const BLOCKS_RESPONSE = "BLOCKS_RESPONSE";
const REQUEST_MEMPOOL = "REQUEST_MEMPOOL";
const MEMPOOL_RESPONSE = "MEMPOOL_RESPONSE";
const HELLO = "HELLO";
const GET_PEERS = "GET_PEERS";
const PEERS_RESPONSE = "PEERS_RESPONSE";

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

const getHeaders = locator => {
  return {
    type: GET_HEADERS,
    data: { locator }
  };
};

/*
 * 블록 소식. 우리 체인의 무게를 함께 실어 상대가 받을지 말지 정하게 한다.
 * 익스플로러는 data 만 읽으므로 옆에 붙인 것은 지나친다.
 * 무게는 말일 뿐이다 — 받는 쪽은 헤더를 받아 직접 잰다.
 */
const blockchainResponse = (data) => {
  return {
    type: BLOCKCHAIN_RESPONSE,
    data,
    // BigInt 는 JSON 에 못 담으므로 10진 문자열로
    work: chainWork(getBlockChain()).toString()
  }
}

const headersResponse = (headers, height) => {
  return {
    type: HEADERS_RESPONSE,
    data: { headers, height }
  };
};

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

// "나는 여기 있다" — 어느 망인지, 그리고 남이 나에게 걸 수 있는 주소(없으면 null)
const hello = url => ({ type: HELLO, data: { network: NETWORK_MAGIC, url } });
const getPeersMessage = () => ({ type: GET_PEERS, data: null });
const peersResponse = peers => ({ type: PEERS_RESPONSE, data: { peers } });

// 소켓 가져오기
const getSockets = () => sockets;

/* ------------------------------------------- 못된 피어 다루기
 *
 * 지금까지는 피어가 무엇을 보내든 연결을 유지했다. 깨진 메시지도, 검증에서
 * 떨어지는 블록도, 초당 수천 건도 그냥 로그만 찍고 넘어갔다. 그래서 한
 * 피어가 계속 쓰레기를 보내며 노드의 CPU 를 먹을 수 있었다.
 *
 * 비트코인처럼 점수를 매긴다. 잘못할 때마다 점수를 더하고, 100점이 되면
 * 끊고 그 주소를 한동안 받지 않는다. 실수 한 번으로 끊지는 않는다 —
 * 깨진 메시지 하나는 버그일 수도 있고 망 사정일 수도 있다.
 */
const BAN_THRESHOLD = 100;
const BAN_DURATION = 24 * 60 * 60 * 1000; // 하루

// 잘못의 무게
const PENALTY = {
  MALFORMED: 10,      // JSON 이 아니거나 모양이 어긋난 메시지
  BAD_BLOCK: 50,      // 검증에서 떨어지는 블록/헤더
  WRONG_NETWORK: 100, // 다른 망 — 바로 끊는다
  FLOOD: 25           // 너무 빨리 보낸다
};

/*
 * 메시지 속도 제한 (토큰 버킷).
 *
 * 동기화 중에는 한꺼번에 많이 오가므로 넉넉해야 한다. 블록 묶음 요청·응답이
 * 오가는 것을 생각하면 초당 50건이면 충분하고, 잠깐 몰리는 것은 200건까지
 * 받아 준다.
 */
const MESSAGE_RATE = 50;   // 초당
const MESSAGE_BURST = 200;

// 주소 -> 밴이 풀리는 시각
const banned = new Map();

const isBanned = address => {
  const until = banned.get(address);
  if (until === undefined) {
    return false;
  }
  if (until <= Date.now()) {
    banned.delete(address);
    return false;
  }
  return true;
};

const banAddress = (address, reason) => {
  if (!address) {
    return;
  }
  banned.set(address, Date.now() + BAN_DURATION);
  console.log(`${address} 를 하루 동안 받지 않습니다: ${reason}`);
};

const getBanned = () =>
  [...banned.entries()]
    .filter(([address]) => isBanned(address))
    .map(([address, until]) => ({ address, until: new Date(until).toISOString() }));

const clearBans = () => {
  const count = banned.size;
  banned.clear();
  return count;
};

// 소켓의 상대 주소 (밴 목록의 열쇠). 우리가 건 연결이면 그 URL.
const addressOf = ws =>
  ws.peerUrl ||
  (ws._socket && ws._socket.remoteAddress) ||
  null;

/*
 * 점수를 더한다. 문턱을 넘으면 끊고 밴한다.
 * 돌려주는 값이 true 면 이 소켓은 더 볼 필요가 없다.
 */
const misbehaving = (ws, points, reason) => {
  ws.banScore = (ws.banScore || 0) + points;
  console.log(`피어가 규칙을 어겼습니다 (+${points} = ${ws.banScore}): ${reason}`);
  if (ws.banScore < BAN_THRESHOLD) {
    return false;
  }
  banAddress(addressOf(ws), reason);
  try {
    ws.close();
  } catch (e) {
    // 이미 닫혔다
  }
  return true;
};

// 너무 빨리 보내는가
const overRateLimit = ws => {
  const now = Date.now();
  if (ws.tokens === undefined) {
    ws.tokens = MESSAGE_BURST;
    ws.tokensAt = now;
  }
  ws.tokens = Math.min(MESSAGE_BURST, ws.tokens + ((now - ws.tokensAt) / 1000) * MESSAGE_RATE);
  ws.tokensAt = now;
  if (ws.tokens < 1) {
    return true;
  }
  ws.tokens -= 1;
  return false;
};

// 서버 시작하기
const startP2PServer = server => {
  const wsServer = new WebSockets.Server({ server, maxPayload: MAX_MESSAGE_BYTES });
  wsServer.on("connection", ws => {
    if (sockets.length >= MAX_PEERS) {
      console.log(`피어 수 상한(${MAX_PEERS})에 걸려 연결을 거절했습니다`);
      ws.close();
      return;
    }
    const from = addressOf(ws);
    if (isBanned(from)) {
      console.log(`밴 중인 주소의 연결을 거절했습니다: ${from}`);
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
  // 망을 먼저 밝힌다. 상대가 다른 망이면 이걸 보고 끊는다.
  sendMessage(ws, hello(publicUrl));
  sendMessage(ws, getLatest());
  // 새로 붙은 피어에게만 mempool 과 피어 목록을 요청한다
  setTimeout(() => {
    sendMessage(ws, getAllMempool());
    sendMessage(ws, getPeersMessage());
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
    if (overRateLimit(ws)) {
      if (misbehaving(ws, PENALTY.FLOOD, `초당 ${MESSAGE_RATE}건을 넘겼습니다`)) {
        return;
      }
      return; // 이번 메시지는 버린다
    }
    const message = parseData(data);
    if (message === null) {
      misbehaving(ws, PENALTY.MALFORMED, "JSON 이 아닙니다");
      return;
    }
    try {
      handleMessage(ws, message);
    } catch (e) {
      console.log(`피어가 보낸 메시지를 처리하다 실패했습니다: ${e.message}`);
      misbehaving(ws, PENALTY.MALFORMED, `처리 중 예외: ${e.message}`);
    }
  });
};

const handleMessage = (ws, message) => {
    if(message === null || typeof message !== "object"){
      misbehaving(ws, PENALTY.MALFORMED, "메시지가 객체가 아닙니다");
      return;
    }
    switch (message.type) {
      case GET_LATEST:
        sendMessage(ws, responseLatest());  // 가장 최근
        break;
      case GET_HEADERS:
        if(message.data === null || typeof message.data !== "object"){
          break;
        }
        sendMessage(ws, responseHeaders(message.data.locator));
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
        handleBlockchainResponse(ws, message.data, message.work);
        break;
      case HEADERS_RESPONSE:
        if(message.data === null || typeof message.data !== "object"){
          break;
        }
        handleHeadersResponse(ws, message.data);
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
        // 새 트랜잭션 한 건(broadcastTx)일 수도, mempool 전체(REQUEST_MEMPOOL 답)일 수도 있다.
        // 낱개로 넣으면 트랜잭션마다 UTxOut 집합을 복제하게 되므로 한 번에 넘긴다.
        handleIncomingTxs(message.data);
        break;
      case HELLO:
        if(message.data === null || typeof message.data !== "object"){
          break;
        }
        if(message.data.network !== NETWORK_MAGIC){
          if (ws.peerUrl) {
            disconnectPeer(ws.peerUrl); // 우리가 건 것이면 다시 걸지도 않는다
          }
          // 다른 망은 실수가 아니다. 바로 끊고 한동안 받지 않는다.
          misbehaving(ws, PENALTY.WRONG_NETWORK, `다른 망입니다 (${message.data.network})`);
          break;
        }
        handleHello(ws, message.data.url);
        break;
      case GET_PEERS:
        sendMessage(ws, peersResponse(addressesToShare(ws)));
        break;
      case PEERS_RESPONSE:
        if(message.data === null || typeof message.data !== "object" || !Array.isArray(message.data.peers)){
          break;
        }
        handlePeersResponse(message.data.peers);
        break;
    }
};

/*
 * 상대가 알려 준 자기 주소. 그 소켓에 붙여 두고, 아는 주소에도 넣는다.
 * 우리 자신의 주소는 배우지 않는다.
 */
const handleHello = (ws, url) => {
  if (url === null || !isPeerUrl(url) || url === publicUrl) {
    return; // 공개 주소를 알리지 않는 피어. 망 확인은 끝났다.
  }
  ws.advertisedUrl = url;
  learnAddress(url);

  /*
   * 같은 상대와 두 번 붙어 있는가.
   *
   * 서로를 동시에 알게 되면 양쪽이 동시에 걸어 소켓이 둘이 된다 (우리가 건
   * 것 + 상대가 건 것). 하나만 남긴다. 양쪽이 같은 규칙으로 정해야 둘 다
   * 끊거나 둘 다 남기는 일이 없다: 공개 주소가 사전순으로 앞선 쪽이 자기가
   * 건 것을 남긴다. 우리 공개 주소가 없으면 상대는 이 상황을 모르므로
   * 우리가 건 것을 남기고 들어온 것을 끊는다.
   */
  const inbound = ws.peerUrl === undefined;
  if (inbound && dialedPeers.has(url)) {
    const keepOurs = publicUrl === null || publicUrl < url;
    if (keepOurs) {
      ws.close();
    } else {
      // 상대가 건 것을 남긴다. 주소는 잊지 않는다 — 끊기면 다시 걸 수 있게.
      disconnectPeer(url);
      knownAddresses.add(url);
    }
  }
};

const learnAddress = url => {
  if (!isPeerUrl(url) || url === publicUrl || knownAddresses.has(url)) {
    return false;
  }
  if (knownAddresses.size >= MAX_KNOWN_ADDRESSES) {
    return false;
  }
  knownAddresses.add(url);
  return true;
};

// 남에게 알려 줄 주소: 우리가 걸어 둔 것 + 상대가 알려 준 것. 묻는 쪽 자기 주소는 뺀다.
const addressesToShare = ws => {
  const urls = new Set(knownAddresses);
  for (const url of dialedPeers.keys()) {
    urls.add(url);
  }
  if (ws.advertisedUrl) {
    urls.delete(ws.advertisedUrl);
  }
  if (publicUrl !== null) {
    urls.delete(publicUrl);
  }
  return Array.from(urls).slice(0, 100);
};

/*
 * 배운 주소 중 아직 붙지 않은 곳에 outbound 상한까지 붙는다.
 * 상대가 보낸 목록은 남의 말이다 — 모양만 보고, 개수에 상한을 두고,
 * 붙는 것도 상한까지만이다.
 */
const handlePeersResponse = peers => {
  for (const url of peers.slice(0, 100)) {
    learnAddress(url);
  }
  fillOutbound();
};

const fillOutbound = () => {
  for (const url of knownAddresses) {
    if (dialedPeers.size >= MAX_OUTBOUND || sockets.length >= MAX_PEERS) {
      return;
    }
    if (dialedPeers.has(url) || isAlreadyConnected(url)) {
      continue;
    }
    try {
      connectToPeers(url);
    } catch (e) {
      // 상한 등. 다음에 다시 본다.
    }
  }
};

// 그 주소가 이미 inbound 로 붙어 있는가 (상대가 HELLO 로 알려 준 주소로)
const isAlreadyConnected = url => sockets.some(ws => ws.advertisedUrl === url);

const returnMempool = () => mempoolResponse(getMempool());

/*
 * 새 블록 소식 (한 블록).
 *
 * 우리 끝에 그대로 이어지면 붙이고 다른 피어에게도 알린다.
 * 그보다 앞서 있는데 이어지지 않으면 — 우리가 몇 블록 뒤처졌거나 체인이
 * 갈라진 것이다 — 그 피어에게 조각으로 달라고 한다.
 * 예전에는 이때 모든 피어에게 체인 전체를 달라고 했다.
 */
const handleBlockchainResponse = (ws, receivedBlocks, claimedWork) => {
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
  if (latestBlockReceived.hash === newestBlock.hash) {
    return; // 우리와 같은 끝이다
  }
  if(newestBlock.hash === latestBlockReceived.previousHash){
    if(addBlockToChain(latestBlockReceived)) {
      broadcastNewBlock();
    }
    return;
  }
  /*
   * 이어지지 않는데 상대가 더 무겁다고 한다 — 뒤처졌거나 갈라진 것이다.
   * 무게를 알려 주지 않는 상대에게는 예전처럼 높이로 짐작한다.
   */
  const heavier =
    typeof claimedWork === "string" && /^\d{1,80}$/.test(claimedWork)
      ? BigInt(claimedWork) > chainWork(getBlockChain())
      : latestBlockReceived.index > newestBlock.index;
  if (heavier) {
    requestHeaders(ws);
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
  const chain = getBlockChain();
  if (sync) {
    if (sync.buffer.length > 0) {
      // 블록을 받는 중: 받은 마지막 블록 다음부터
      hashes.push(sync.buffer[sync.buffer.length - 1].hash);
    } else if (sync.phase === "blocks" && sync.forkParent !== undefined) {
      // 헤더로 갈라진 지점을 알았다: 그 다음부터
      hashes.push(chain[sync.forkParent].hash);
    } else if (sync.phase === "headers" && sync.headerHashes.length > 0) {
      // 헤더를 받는 중: 받은 마지막 헤더 다음부터
      hashes.push(sync.headerHashes[sync.headerHashes.length - 1]);
    }
  }
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

const freshSyncState = () => ({
  phase: null,        // null | "headers" | "blocks"
  window: null,       // 검증에 쓰는 마지막 HEADER_WINDOW 개 (우리 체인 끝 + 받은 헤더)
  headerWork: 0n,     // 갈라진 지점까지의 우리 체인 + 받은 헤더의 누적 무게 (BigInt)
  headerHashes: [],   // 받아서 검증한 헤더의 해시 (순서대로)
  forkParent: undefined,
  expected: null,     // 블록 단계에서 받아야 할 블록 해시들 (헤더에서)
  buffer: [],
  inFlight: false,
  requestedAt: 0,
  progressed: false
});

const syncStateOf = ws => {
  if (!ws.sync) {
    ws.sync = freshSyncState();
  }
  return ws.sync;
};

const isStale = sync =>
  sync.inFlight && Date.now() - sync.requestedAt >= SYNC_REQUEST_TIMEOUT;

const requestHeaders = ws => {
  let sync = syncStateOf(ws);
  if (sync.phase === "blocks" && !isStale(sync)) {
    return; // 이미 블록을 받는 중이다. 끝나면 새 소식은 다시 온다.
  }
  if (isStale(sync)) {
    resetSync(ws, "응답이 없어 처음부터 다시 합니다");
    sync = syncStateOf(ws);
  }
  if (sync.inFlight) {
    return;
  }
  sync.phase = "headers";
  sync.inFlight = true;
  sync.requestedAt = Date.now();
  sendMessage(ws, getHeaders(buildLocator(sync)));
};

const requestBlocks = ws => {
  const sync = syncStateOf(ws);
  if (sync.inFlight && !isStale(sync)) {
    return; // 이미 달라고 해 놨다
  }
  sync.phase = "blocks";
  sync.inFlight = true;
  sync.requestedAt = Date.now();
  sendMessage(ws, getBlocks(buildLocator(sync)));
};

// locator 중 우리도 아는 첫 해시의 다음 높이. 하나도 모르면 제네시스(0).
const startAfterLocator = locator => {
  if (!Array.isArray(locator)) {
    return 0;
  }
  for (const hash of locator) {
    if (typeof hash !== "string") {
      continue;
    }
    const height = ChainIndex.findBlockHeight(hash);
    if (height !== undefined) {
      return height + 1;
    }
  }
  return 0;
};

// GET_HEADERS 에 답한다. 헤더는 작으므로 개수만 본다.
const responseHeaders = locator => {
  const chain = getBlockChain();
  const start = startAfterLocator(locator);
  const headers = chain.slice(start, start + MAX_HEADERS_PER_BATCH).map(headerOf);
  return headersResponse(headers, chain.length - 1);
};

/*
 * 받은 헤더를 검증하며 쌓는다. 다 받으면 무게를 재서 블록을 받을지 정한다.
 *
 * 검증에는 "이 헤더 앞에 오는 체인"이 필요하다 (난이도와 MTP 가 앞선 여러
 * 블록에서 나온다). 그 둘은 마지막 열 몇 개만 보므로 창(window)으로
 * 충분하다 — 갈라진 지점까지의 우리 체인 끝에 받은 헤더를 이어 붙인다.
 */
const handleHeadersResponse = (ws, data) => {
  const { headers, height } = data;
  if (!Array.isArray(headers)) {
    return;
  }
  const sync = syncStateOf(ws);
  if (sync.phase !== "headers") {
    return; // 달라고 한 적 없다
  }
  sync.inFlight = false;

  if (headers.length === 0) {
    finishHeaders(ws);
    return;
  }

  if (sync.window === null) {
    // 첫 묶음. 우리 체인 어딘가에 붙어야 한다.
    const first = headers[0];
    if (first === null || typeof first !== "object" || typeof first.previousHash !== "string") {
      resetSync(ws, "받은 헤더의 모양이 맞지 않습니다", true);
      return;
    }
    const forkParent = ChainIndex.findBlockHeight(first.previousHash);
    if (forkParent === undefined) {
      resetSync(ws, "받은 헤더가 우리 체인 어디에도 붙지 않습니다");
      return;
    }
    const chain = getBlockChain();
    sync.forkParent = forkParent;
    sync.window = chain.slice(Math.max(0, forkParent + 1 - HEADER_WINDOW), forkParent + 1);
    sync.headerWork = chainWork(chain.slice(0, forkParent + 1));
  }

  for (const header of headers) {
    if (sync.headerHashes.length >= MAX_HEADER_BUFFER) {
      resetSync(ws, `헤더가 ${MAX_HEADER_BUFFER} 개를 넘습니다`);
      return;
    }
    if (!isHeaderValid(header, sync.window)) {
      resetSync(ws, `헤더 #${header && header.index} 이 검증에서 떨어졌습니다`, true);
      return;
    }
    sync.window.push(header);
    if (sync.window.length > HEADER_WINDOW) {
      sync.window.shift();
    }
    sync.headerWork += Target.workOf(header.bits);
    sync.headerHashes.push(header.hash);
  }

  const lastReceived = headers[headers.length - 1].index;
  if (typeof height === "number" && lastReceived >= height) {
    finishHeaders(ws);
    return;
  }
  requestHeaders(ws);
};

// 헤더를 다 받았다. 우리보다 무거우면 그 블록들을 받기 시작한다.
const finishHeaders = ws => {
  const sync = syncStateOf(ws);
  if (sync.window === null) {
    resetSync(ws);
    return;
  }
  const theirs = sync.headerWork;
  const ours = chainWork(getBlockChain());
  const theirHeight = sync.forkParent + sync.headerHashes.length;
  if (theirs <= ours) {
    resetSync(
      ws,
      `받은 헤더 체인(높이 ${theirHeight}, 무게 ${theirs})이 우리 것(높이 ${getBlockChain().length - 1}, 무게 ${ours})보다 무겁지 않습니다`
    );
    return;
  }
  // 블록 단계. 받아야 할 것이 정확히 무엇인지 안다.
  sync.expected = new Set(sync.headerHashes);
  sync.window = null;
  sync.headerHashes = [];
  sync.headerWork = 0n;
  sync.inFlight = false;
  requestBlocks(ws);
};

/*
 * GET_BLOCKS 에 답한다. locator 중 우리도 아는 첫 해시 다음부터 한 묶음.
 * 개수와 크기 둘 다에 상한을 둔다 — 블록 하나가 트랜잭션 100건이면 60KB 쯤이라
 * 개수만 보면 4MB 를 훌쩍 넘을 수 있다.
 */
const responseBlocks = locator => {
  const chain = getBlockChain();
  const start = startAfterLocator(locator);

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

/*
 * 동기화를 접는다. blame 이 true 면 상대가 잘못 보낸 것이므로 점수를 매긴다
 * (우리가 이미 더 무겁다 같은 정상적인 중단에는 매기지 않는다).
 */
const resetSync = (ws, reason, blame = false) => {
  if (reason) {
    console.log(`동기화를 중단합니다: ${reason}`);
  }
  ws.sync = freshSyncState();
  if (blame) {
    misbehaving(ws, PENALTY.BAD_BLOCK, reason);
  }
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
    resetSync(ws, "받은 묶음이 서로 이어지지 않습니다", true);
    return;
  }
  // 헤더를 먼저 받았다면, 그때 본 블록만 받는다
  if (sync.expected !== null && !blocks.every(block => sync.expected.has(block.hash))) {
    resetSync(ws, "헤더에 없던 블록이 왔습니다", true);
    return;
  }

  if (sync.buffer.length === 0 && blocks[0].previousHash === getNewestBlock().hash) {
    // 우리 끝에 그대로 이어진다. 하나씩 붙이고 쌓아 두지 않는다.
    for (const block of blocks) {
      if (!addBlockToChain(block)) {
        resetSync(ws, `블록 #${block.index} 이 검증에서 떨어졌습니다`, true);
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
      resetSync(ws, "받은 묶음이 앞서 받은 것에 이어지지 않습니다", true);
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
  ws.sync = freshSyncState();
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
// 맴풀 전달하기 (REQUEST_MEMPOOL 에 답할 때, 그리고 피어가 새로 붙었을 때)
const broadcastMempool = () => sendMessageToAll(returnMempool());
/*
 * 새 트랜잭션 한 건만 알린다.
 *
 * 예전에는 트랜잭션이 하나 들어올 때마다 mempool 을 통째로 보냈다. 받는
 * 쪽은 이미 가진 것까지 다시 검증하고(서명 확인 포함), 피어 수 × mempool
 * 크기만큼 트래픽이 났다. mempool 이 100건이면 한 건 보내는 데 100건이
 * 오간 셈이다. 비트코인의 inv/tx 처럼 새 것만 보낸다.
 */
const broadcastTx = tx => sendMessageToAll(mempoolResponse([tx]));

// 에러 체크
const handleSocketError = ws => {
  const closeSocketConnetion = ws => {
    clearInterval(ws.keepAliveId);
    ws.close();
    const index = sockets.indexOf(ws);
    if (index !== -1) {
      sockets.splice(index, 1);
    }
    // 우리가 건 연결이면 다시 건다 (connectToPeers 의 close 핸들러가 한다)
  };
  ws.on("error", () => closeSocketConnetion(ws));
  ws.on("close", () => closeSocketConnetion(ws));
};

const scheduleReconnect = url => {
  const peer = dialedPeers.get(url);
  if (!peer || peer.timer !== null) {
    return; // 잊힌 피어거나 이미 걸어 둔 재연결이 있다
  }
  const delay = Math.min(RECONNECT_MIN * Math.pow(2, peer.attempts), RECONNECT_MAX);
  peer.attempts++;
  peer.timer = setTimeout(() => {
    peer.timer = null;
    dial(url);
  }, delay);
  peer.timer.unref();
};

const dial = url => {
  if (isBanned(url)) {
    console.log(`밴 중인 피어에는 걸지 않습니다: ${url}`);
    return;
  }
  const peer = dialedPeers.get(url);
  if (!peer) {
    return;
  }
  if (sockets.length >= MAX_PEERS) {
    scheduleReconnect(url);
    return;
  }
  const ws = new WebSockets(url, { maxPayload: MAX_MESSAGE_BYTES });
  ws.peerUrl = url;
  peer.socket = ws;

  ws.on("open", () => {
    peer.attempts = 0; // 붙었다. 다음에 끊기면 짧게부터 다시 시작한다.
    initSocketConnection(ws);
  });
  // error 뒤에는 close 가 이어지므로 재연결은 close 에서만 건다
  ws.on("error", () => {
    console.log(`피어에 연결하지 못했습니다: ${url}`);
  });
  ws.on("close", () => {
    peer.socket = null;
    if (dialedPeers.has(url)) {
      scheduleReconnect(url);
    }
  });
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

// 남이 나에게 걸 수 있는 주소를 정한다. 뜰 때 한 번.
const setPublicUrl = url => {
  if (!isPeerUrl(url)) {
    throw Error("공개 주소는 ws:// 또는 wss:// 여야 합니다");
  }
  publicUrl = url;
};

const connectToPeers = newPeer => {
  if (newPeer === publicUrl) {
    throw Error("자기 자신에게는 붙지 않습니다");
  }
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
  dialedPeers.set(newPeer, { attempts: 0, timer: null, socket: null });
  dial(newPeer);
};

// 이 피어를 잊는다. 재연결도 멈춘다.
const disconnectPeer = url => {
  const peer = dialedPeers.get(url);
  if (!peer) {
    return false;
  }
  dialedPeers.delete(url);
  if (peer.timer !== null) {
    clearTimeout(peer.timer);
  }
  if (peer.socket !== null) {
    peer.socket.close();
  }
  return true;
};

// 우리가 걸어 둔 피어 주소들 (지금 붙어 있든 다시 거는 중이든)
const getDialedPeers = () => Array.from(dialedPeers.keys());

// 연결된 피어 주소 목록
const getPeers = () =>
  sockets.map(ws => {
    if (ws.peerUrl) {
      return ws.peerUrl;
    }
    if (ws.advertisedUrl) {
      return ws.advertisedUrl; // 상대가 알려 준 자기 주소
    }
    const socket = ws._socket;
    return socket ? `${socket.remoteAddress}:${socket.remotePort}` : "unknown";
  });

// 배웠지만 아직 붙지 않은 것까지 포함해, 아는 주소 전부
const getKnownAddresses = () => Array.from(knownAddresses);

module.exports = {
  // 테스트가 소켓 없이 메시지 처리를 부를 수 있게 열어 둔다
  handleMessage,
  buildLocator,
  MAX_BLOCKS_PER_BATCH,
  MAX_HEADERS_PER_BATCH,
  HEADER_WINDOW,
  startP2PServer,
  setPublicUrl,
  connectToPeers,
  disconnectPeer,
  getDialedPeers,
  getKnownAddresses,
  getPeers,
  MAX_OUTBOUND,
  NETWORK_MAGIC,
  broadcastNewBlock,
  broadcastMempool,
  broadcastTx,
  getBanned,
  clearBans,
  isBanned,
  misbehaving,
  BAN_THRESHOLD,
  PENALTY,
  MESSAGE_RATE,
  MESSAGE_BURST
};
