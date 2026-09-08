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
2. connectToPeers / disconnectPeer
3. broadcastNewBlock
4. broadcastMempool
5. getPeers

| 메시지 | 뜻 |
|---|---|
| `GET_LATEST` → `BLOCKCHAIN_RESPONSE [블록] + work` | 끝 블록 하나와 체인 무게. 새 블록 소식도 이걸로 알린다 |
| `GET_HEADERS {locator}` → `HEADERS_RESPONSE {headers, height}` | locator 중 아는 첫 해시 다음부터 헤더 2000개 |
| `GET_BLOCKS {locator}` → `BLOCKS_RESPONSE {blocks, height}` | 같은 자리부터 블록 500개 / 4MB |
| `REQUEST_MEMPOOL` → `MEMPOOL_RESPONSE [tx]` | 대기 중인 트랜잭션 |
| `HELLO {url}` | 내 공개 주소 (LIMCOIN_PUBLIC_URL 이 있을 때) |
| `GET_PEERS` → `PEERS_RESPONSE {peers}` | 아는 피어 주소 (묻는 쪽 자기 것은 빼고) |

익스플로러는 피어인 척 붙어 `BLOCKCHAIN_RESPONSE` 와 `MEMPOOL_RESPONSE` 만 듣는다.

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
| GET  | `/me/mnemonic` | 백업용 니모닉 🔒 |
| POST | `/me/restore` | 니모닉으로 지갑 복구 🔒 |
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

### bip39.js
니모닉 <-> 엔트로피 <-> 씨앗. 공식 테스트 벡터로 검증한다.
단어 목록은 `bip39-wordlist.js`.

### pow.js / pow-worker.js
작업증명. 해시 계산은 메인 스레드와 워커가 함께 쓰므로 따로 두었다.
`findNonce(header, from, budget, stride)` 의 `stride` 로 워커들이 nonce
공간을 나눠 맡는다.

### hdwallet.js
BIP32 방식 키 파생. `masterFromSeed`, `deriveChild`, `derivePrivateKey`.
Node 내장 `crypto` 의 HMAC-SHA512 만 쓴다.

### addressIndex.js
주소별 트랜잭션 색인. 블록을 붙일 때 갱신하므로 지갑과 익스플로러가
체인을 훑지 않아도 된다. 체인이 갈라지면 그 높이부터만 걷어 낸다.

### chainIndex.js
블록 해시 / 트랜잭션 id -> 블록 높이 색인. 조회가 전부 체인 훑기이던 것을
없앤다. addressIndex 와 같은 자리에서 갱신하고 같은 방식으로 되감는다.

### store.js
체인을 `blocks.jsonl` 에, 대기 중인 트랜잭션을 `mempool.jsonl` 에 저장하고
읽는다. 블록은 append-only(reorg 시에만 통째로 다시 쓴다), mempool 은
블록이 붙을 때마다 바뀌므로 그때그때 갈아 끼운다.

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

### keys.js
secp256k1 키·서명(Node `crypto`). 비압축 공개키, DER low-S 서명, 검증.
예전의 elliptic / crypto-js / bn.js 를 대신한다.

### serialization.js
트랜잭션·블록 헤더의 바이트 직렬화와 `sha256d`. txid 와 블록 해시가 여기서 나온다.

### address.js
Base58Check 주소(`RIPEMD160(SHA256(공개키))`), 망 버전 바이트, 예전 형식 호환.

### params.js
망 파라미터 — 제네시스 파일, 주소 버전, P2P 매직, 데이터 경로. `LIMCOIN_NETWORK`.
