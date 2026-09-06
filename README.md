# LimCoin
LimCoin, the coin made in NodeJS

## 시작하기

```bash
yarn install
yarn genesis      # 최초 1회: 제네시스 블록과 지갑 개인키 생성
yarn dev          # 개발 서버 (nodemon)
yarn test         # 검증 로직 테스트
```

기본 포트는 3000. `HTTP_PORT` 환경변수로 바꿀 수 있다.
여러 노드를 띄우려면 각각 다른 포트로 실행한 뒤 `POST /peers` 로 연결한다.

```bash
HTTP_PORT=4001 yarn start
HTTP_PORT=4002 yarn start
curl -X POST localhost:4002/peers -H 'Content-Type: application/json' -d '{"peer":"ws://localhost:4001"}'
```

### 제네시스 블록과 개인키

- `src/genesis.json` — 제네시스 블록. **공개 정보이며 커밋 대상**이다.
  체인에 참여하는 모든 노드가 같은 파일을 공유해야 한다.
- `src/privateKey` — 노드 지갑의 개인키. **`.gitignore` 대상이며 절대 커밋하면 안 된다.**
  없으면 서버가 처음 뜰 때 자동 생성된다.

새 체인을 시작하려면 `yarn genesis` 를 실행한다. 제네시스 프리마인(10 LIM)은
그때 만들어진 `src/privateKey` 를 가진 사람만 쓸 수 있으므로, 이 키를 안전한 곳에 보관할 것.

> 과거 버전은 제네시스 주소의 개인키를 `src/privateKey` 로 저장소에 함께 커밋했다.
> 그 주소는 폐기되었고, 해당 키는 더 이상 사용해서는 안 된다.



## 블록체인 원리 이해하기
-----------------------------

기본 환경
-  Nodejs , Npm 설치
-  Yarn 설치


------------------------------


- Block 구조체 만들기
#3

- BlockChain 에 Block 추가하기
#6

- BlockCahin 검증하기
    - (미사용) Typescript 를 이용하면 편하게 만들 수 있음 .ts
    - (미사용) tsc-watch, typescript( tsconfig.json )

- Send Messages P2P and Actions 싱크 Chain
#12

- Broadcasting
#13

- Transections
#22


--------------------------

###  사용 라이브러리
- hex-to-binary 
- lodash 
- elliptic
- Express
- body-parser
- morgan
- cors
- crypto-js
- lodash
- nodemon
- ws

-----------------

### Version infomation
    "body-parser": "^1.18.2",
    "cors": "^2.8.4",
    "crypto-js": "^3.1.9-1",
    "elliptic": "^6.4.0",
    "express": "^4.16.3",
    "hex-to-binary": "^1.0.1",
    "lodash": "^4.17.10",
    "morgan": "^1.9.0",
    "nodemon": "^1.17.3",
    "ws": "^5.1.1"


# 주요 사용 Function 정리
### blockchain.js
1. genesisTx, genesisBlock 초기 제네시스 Tx, block 생성 함수
2. getNewestBlock 새로운(가장 최근) 블럭 가져오기 함수
3. hashMatchesDifficulty, calculateNewDifficulty 난이도 계산, 설정 함수
4. createHash 해쉬 만들기 함수 CryptoJS 사용


### memPool.js
1. addToMempool
2. getMempool
3. updateMempool

### p2p.js
1. startP2PServer
2. connectToPeers
3. broadcastNewBlock
4. broadcastMempool
5. getPeers

### server.js
`start(port)` 로 HTTP + P2P 서버를 띄운다. `node src/server.js` 로 직접 실행하면 자동으로 뜬다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET  | `/blocks` | 전체 블록체인 |
| POST | `/blocks` | 새 블록 채굴 |
| GET  | `/blocks/:hash` | 해시로 블록 조회 |
| GET  | `/peers` | 연결된 피어 목록 |
| POST | `/peers` | 피어 연결 (`{"peer":"ws://host:port"}`) |
| GET  | `/transactions` | mempool |
| POST | `/transactions` | 송금 (`{"address":"04...","amount":10}`) |
| GET  | `/transactions/:id` | id 로 트랜잭션 조회 |
| GET  | `/me/balance` | 내 잔액 |
| GET  | `/me/address` | 내 주소 |
| GET  | `/address/:address` | 특정 주소 잔액 |


### transaction.js
1. getPublicKey
2. getTxId
3. signTxIn
4. TxIn
5. Transaction
6. TxOut
7. createCoinbaseTx
8. processTxs
9. validateTx

### utils.js
1. toHexString

### scripts/generate-genesis.js
제네시스 블록(`src/genesis.json`)과 지갑 개인키(`src/privateKey`)를 새로 만든다.

### wallet.js
1. initWallet
2. getBalance
3. getPublicFromWallet
4. createTx
5. getPrivateFromWallet
