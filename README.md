# LimCoin
LimCoin, the coin made in NodeJS

## 시작하기

```bash
yarn install
yarn genesis      # 최초 1회: 제네시스 블록과 지갑 생성
yarn dev          # 개발 서버 (nodemon)
yarn test         # 테스트
```

> Node 18 이상이 필요하다. 테스트는 Node 내장 `node:test` 를 쓰므로
> 테스트 프레임워크를 따로 설치하지 않는다.

### 환경변수

| | |
|---|---|
| `HTTP_PORT` | HTTP 포트 (기본 3000) |
| `LIMCOIN_DATA_DIR` | 체인 저장 위치 (기본 `data/<포트>`) |
| `LIMCOIN_WALLET_TOKEN` | 지갑 API 토큰. 지정하지 않으면 뜰 때 만들어 콘솔에 찍는다. `none` 이면 인증을 끈다(로컬 실습용) |
| `LIMCOIN_MINE` | `1` 이면 뜨자마자 자동 채굴 시작 |

### 공개 API 와 지갑 API

읽기 전용 엔드포인트(`GET /blocks`, `/transactions`, `/peers`, `/address/*`, `/info`)는
누구나 부를 수 있고 CORS 도 열려 있다. 익스플로러가 붙어야 하기 때문이다.

**지갑을 건드리는 엔드포인트는 토큰을 요구하고 CORS 를 막는다.**
`/me/*`, `POST /blocks`, `POST /transactions`, `POST /peers`, `POST /mining` 이 여기 해당한다.
이게 없으면 노드 포트에 닿는 누구나 그 노드의 코인을 빼갈 수 있고,
아무 웹페이지나 방문자의 로컬 노드에 송금 요청을 보낼 수 있다.

```bash
curl -H "Authorization: Bearer $LIMCOIN_WALLET_TOKEN" localhost:3000/me/balance
```

### 체인 저장

블록은 `data/<포트>/blocks.jsonl` 에 한 줄에 하나씩 쌓인다(JSON Lines).
노드를 재시작하면 이 파일을 읽어 하나씩 다시 검증하며 UTxOut 집합을
재구성한다. 검증에 실패하는 블록이 나오면 거기까지만 복원하고 나머지는
P2P 로 다시 받는다.

체인 교체(reorg)는 append 로 표현할 수 없으므로 그때만 파일을 새로 쓴다.
임시 파일에 쓰고 rename 하므로 도중에 죽어도 반쯤 쓰인 파일이 남지 않는다.

### 자동 채굴

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true}' localhost:3000/mining
```

블록이 꾸준히 나와야 난이도 조절이 의미를 갖는다. 예전에는 `POST /blocks` 를
사람이 쳐야만 블록이 생겨서, 난이도 조절이 사실상 "사람이 curl 을 치는 속도"를
재고 있었다.

채굴은 이벤트 루프를 막지 않는다. 일정 해시마다 양보하므로 채굴 중에도
HTTP 응답과 P2P 메시지가 처리된다.

기본 포트는 3000. `HTTP_PORT` 환경변수로 바꿀 수 있다.
여러 노드를 띄우려면 각각 다른 포트로 실행한 뒤 `POST /peers` 로 연결한다.

```bash
HTTP_PORT=4001 yarn start
HTTP_PORT=4002 yarn start
curl -X POST localhost:4002/peers -H 'Content-Type: application/json' -d '{"peer":"ws://localhost:4001"}'
```

### 제네시스 블록과 지갑

- `src/genesis.json` — 제네시스 블록. **공개 정보이며 커밋 대상**이다.
  체인에 참여하는 모든 노드가 같은 파일을 공유해야 한다.
- `src/wallet.json` — 지갑. 씨앗이 들어 있다.
  **`.gitignore` 대상이며 절대 커밋하면 안 된다.**
  없으면 서버가 처음 뜰 때 자동 생성된다.

예전 형식(개인키 하나짜리 `src/privateKey`)이 남아 있으면 첫 실행 때
지갑으로 가져온다. 그 주소의 잔액은 그대로 쓸 수 있다.

새 체인을 시작하려면 `yarn genesis` 를 실행한다. 제네시스 프리마인(10 LIM)은
그때 만들어진 `src/privateKey` 를 가진 사람만 쓸 수 있으므로, 이 키를 안전한 곳에 보관할 것.

> 과거 버전은 제네시스 주소의 개인키를 `src/privateKey` 로 저장소에 함께 커밋했다.
> 그 주소는 폐기되었고, 해당 키는 더 이상 사용해서는 안 된다.



## 화폐 정책

| | |
|---|---|
| 최소 단위 | 1 LIM = 100,000,000 lm (비트코인의 사토시에 해당) |
| 초기 블록 보조금 | 10 LIM |
| 반감기 | 210,000 블록마다 |
| 총 발행량 상한 | 약 4,200,000 LIM |
| 블록당 트랜잭션 | 최대 100개 |
| mempool 상한 | 500건 |

**프로토콜과 HTTP API 는 모두 최소 단위(lm) 정수로 주고받는다.** 부동소수점을
쓰지 않으므로 노드마다 반올림이 갈릴 일이 없다. 사람에게 보여 줄 때만 LIM 으로
환산한다 (`src/units.js` 의 `parseLim` / `formatLim`).

```bash
# 6 LIM 을 수수료 0.25 LIM 으로 보내기
curl -X POST localhost:3000/transactions -H 'Content-Type: application/json' \
  -d '{"address":"04...","amount":600000000,"fee":25000000}'
```

현재 정책은 `GET /info` 로 확인할 수 있다.

### 백서와의 대응

이 구현은 [Bitcoin 백서](https://bitcoin.org/bitcoin.pdf)의 다음 부분을 따른다.

**6장 Incentive — 수수료와 반감기**

> "If the output value of a transaction is less than its input value, the
> difference is a transaction fee that is added to the incentive value of the
> block containing the transaction."

입력합에서 출력합을 뺀 차액이 수수료가 되고, 그 블록을 채굴한 사람이
보조금과 함께 가져간다. 수수료를 위한 별도 출력을 만들지 않는다.

> "Once a predetermined number of coins have entered circulation, the incentive
> can transition entirely to transaction fees and be completely inflation free."

보조금은 210,000 블록마다 절반이 되고 결국 0 으로 수렴한다. 그 뒤로는
수수료만 남는다.

**7장 Reclaiming Disk Space — 머클 트리**

> "transactions are hashed in a Merkle Tree, with only the root included in
> the block's hash."

블록 헤더가 커밋하는 것은 `index`, `previousHash`, `timestamp`, `merkleRoot`,
`difficulty`, `nonce` 뿐이다. 트랜잭션 목록은 머클 루트를 통해서만 묶인다.

**10장 Privacy — 트랜잭션마다 새 키**

> "As an additional firewall, a new key pair should be used for each
> transaction to keep them from being linked to a common owner."

예전 지갑은 개인키 하나를 만들어 영원히 재사용했다. 그 주소에 얽힌 모든
거래가 한 사람의 것으로 묶여 버린다.

이제 씨앗 하나에서 필요한 만큼 키를 파생한다(BIP32와 같은 방식,
`src/hdwallet.js`). 백업할 것은 여전히 하나지만 주소는 얼마든지 쓸 수 있다.

갈래를 둘로 나눈다.

| 경로 | |
|---|---|
| `m/0/i` | 받는 주소 — 남에게 알려 주는 주소 |
| `m/1/i` | 거스름돈 — 내가 나에게 돌려받는 주소 |

**송금할 때마다 거스름돈은 새 주소로 받는다.** 나누지 않으면 거스름돈
주소가 곧 다음 받는 주소가 되어, 남에게 알려 준 주소와 거스름돈이 같은
것이 된다.

구현은 BIP32 공식 테스트 벡터로 검증한다(`test/hdwallet.test.js`).
BIP39 니모닉은 2048단어 목록이 필요해 다루지 않는다 — 씨앗을 16진수로 쓴다.

**8장 Simplified Payment Verification — 머클 증명**

`GET /transactions/:id/proof` 로 특정 트랜잭션이 블록에 담겼다는 증명을
받을 수 있다. 검증하는 쪽은 블록 전체가 아니라 헤더의 `merkleRoot` 와
log₂(n) 개의 해시만 있으면 된다.

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
| GET  | `/blocks` | 블록 목록 (최신순, 기본 50개). `?limit`, `?offset`, 전체 개수는 `X-Total-Count` 헤더 |
| POST | `/blocks` | 새 블록 채굴 🔒 |
| GET  | `/blocks/:hash` | 해시로 블록 조회 |
| GET  | `/peers` | 연결된 피어 목록 |
| POST | `/peers` | 피어 연결 (`{"peer":"ws://host:port"}`) 🔒 |
| GET  | `/transactions` | mempool |
| POST | `/transactions` | 송금 (`{"address":"04...","amount":600000000,"fee":25000000}`) 🔒 |
| GET  | `/transactions/:id` | id 로 트랜잭션 조회 |
| GET  | `/transactions/:id/proof` | 머클(SPV) 증명 |
| GET  | `/info` | 화폐 정책, 체인 통계(높이/tx수/발행량), 채굴 상태 |
| GET  | `/search/:query` | 검색어가 블록/트랜잭션/주소 중 무엇인지 판별 |

🔒 = 지갑 토큰 필요
| GET  | `/me/balance` | 내 잔액 🔒 |
| GET  | `/me/address` | 지금 받는 주소 🔒 |
| POST | `/me/address` | 받는 주소를 새로 만든다 🔒 |
| GET  | `/me/addresses` | 지갑의 모든 주소와 잔액 🔒 |
| GET  | `/mining` | 자동 채굴 상태 |
| POST | `/mining` | 자동 채굴 켜기/끄기 (`{"enabled":true}`) 🔒 |
| GET  | `/address/:address` | 특정 주소 잔액 |
| GET  | `/address/:address/transactions` | 주소의 트랜잭션 내역 (`?limit`, `?offset`) |
| GET  | `/address/:address/utxos` | 주소가 가진 미사용 출력 |


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

### hdwallet.js
BIP32 방식 키 파생. `masterFromSeed`, `deriveChild`, `derivePrivateKey`.
Node 내장 `crypto` 의 HMAC-SHA512 만 쓴다.

### addressIndex.js
주소별 트랜잭션 색인. 블록을 붙일 때 갱신하므로 지갑과 익스플로러가
체인을 훑지 않아도 된다.

### store.js
체인을 `blocks.jsonl` 에 저장하고 읽는다. append-only, reorg 시에만 통째로 다시 쓴다.

### utxo.js
UTxOut 색인. 아웃포인트(`txOutId:index`) 와 주소 기준. 검증이 선형 스캔이던 것을 없앤다.

### miner.js
자동 채굴 루프. start / stop / getStatus.

### units.js
최소 단위 변환. `parseLim("1.5") === 150000000`, `formatLim(150000000) === "1.5"`

### merkle.js
1. getMerkleRoot — 트랜잭션 목록의 머클 루트
2. getMerkleProof — 특정 트랜잭션의 포함 증명
3. verifyMerkleProof — 루트만으로 증명 검증

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
