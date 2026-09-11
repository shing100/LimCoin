### blockchain.js
1. initChain 디스크의 체인을 읽어 검증·색인을 세우고 제네시스에서 시작한다
2. addBlockToChain / isBlockValid / isHeaderValid 블록을 받아 검증해 붙인다
3. bitsForNext 다음 블록의 압축 목표값(target.js 의 LWMA), findBits 채굴용 기대값
4. getNewestBlock / getBlockByHash / getBlockByHeight / findTx 조회
5. sendTx 지갑 송금, getTxProof 머클(SPV) 증명, getUTxOutList / getRichList / getBlockSeries 집계 재료
6. MAX_REORG_DEPTH 되감기 상한(기본 100)

### target.js
1. targetFromBits / bitsFromTarget 압축 목표값 인코딩 (비트코인 nBits)
2. workOf, difficultyOf 무게와 표시용 난이도
3. nextTargetBits LWMA 로 다음 목표값
4. compileTarget / hashMeetsCompiled 채굴 루프용 빠른 비교


### transport.js
1. loadIdentity / nodeId 노드 신원키 (Ed25519)
2. startSession / unwrap 핸드셰이크 (임시 X25519 + 서명)
3. wrap / drainQueue 프레임 암호화 (ChaCha20-Poly1305)
4. splitPinned 주소에 붙인 신원 떼어 내기

### store.js
체인은 `blocks.jsonl` 에, 대기 중인 트랜잭션은 `mempool.jsonl` 에 남긴다.
블록은 append-only(reorg 시에만 통째로 다시 쓴다), mempool 은 블록이 붙을
때마다 갈아 끼운다.

1. scanBlocks 한 줄씩 훑기 (줄 위치 기록)
2. readBlockAt 블록 하나만 읽기
3. truncateBlocksTo 갈라진 지점부터 잘라 내기
4. loadChainstate / saveChainstate UTxOut 스냅샷

### script.js
1. parse, toAsm, compile 스크립트 읽기/쓰기
2. run 스택 기계 (OP_CHECKMULTISIG, OP_CHECKLOCKTIMEVERIFY, OP_IF/ELSE …)
3. multisig, timeLocked, hashTimeLocked 표준 스크립트
4. describe 표준 꼴 알아보기

### memPool.js
1. addToMempool 검증·수수료율 하한을 보고 넣는다(RBF·자리 비우기 포함)
2. getMempool / updateMempool 사본과 블록 뒤 정리
3. selectTxsForBlock 블록에 담을 트랜잭션 고르기(CPFP 묶음 수수료율 순)
4. estimateFee 권장 수수료(perByte·typicalTx), getSpendableUTxOuts / getMatureUTxOuts
5. 상한 MAX_MEMPOOL_BYTES(5MB)·MAX_MEMPOOL_SIZE(5000건), onChange/getVersion 변경 알림

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
| GET  | `/blocks/since/:hash` | 그 블록 뒤의 블록들(≤500). 없으면 404 — 입금 감시·reorg 감지용 |
| GET  | `/blocks/height/:height` | 높이로 블록 하나 |
| GET  | `/blocks/:hash` | 해시로 블록 조회 |
| GET  | `/transactions` | mempool |
| GET  | `/transactions/:id` | id 로 트랜잭션 조회 (`confirmations`, `blockIndex` 포함) |
| GET  | `/transactions/:id/proof` | 머클(SPV) 증명 |
| POST | `/transactions/raw` | 밖에서 서명한 트랜잭션 제출 (인증 없음) |
| POST | `/transactions/build` | 서명하지 않은 트랜잭션과 서명 대상(txid) 만들기 |
| POST | `/script/address` | 표준 스크립트(P2SH) 주소 — multisig·timelock·htlc·raw |
| POST | `/script/decode` | redeemScript 를 풀어 읽기 |
| GET  | `/info` | 화폐 정책, 체인 통계(높이/tx수/발행량), 채굴 상태, 권장 수수료, 버전 |
| GET  | `/health` | 상태 (tipAge·peers·mempool·지갑 여부) |
| GET  | `/metrics` | Prometheus 지표 |
| GET  | `/fees` | 권장 수수료 (`perByte`, `typicalTx`, `congested`) |
| GET  | `/richlist` | 잔액 상위 주소 순위 (≤500) |
| GET  | `/stats/blocks` | 최근 블록의 난이도·간격·트랜잭션 수 (≤2000) |
| GET  | `/peers` | 연결된 피어 목록 |
| GET  | `/peers/known` | 아는 피어 주소 |
| GET  | `/peers/detail` | 피어마다 암호화 여부와 상대 노드 id |
| GET  | `/peers/banned` | 일시 밴 목록 |
| GET  | `/address/:address` | 특정 주소 잔액 |
| GET  | `/address/:address/transactions` | 주소의 트랜잭션 내역 (`?limit`, `?offset`) |
| GET  | `/address/:address/utxos` | 주소가 가진 미사용 출력 |
| GET  | `/search/:query` | 검색어가 블록/트랜잭션/주소 중 무엇인지 판별 |

🔒 = 지갑 토큰 필요

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/blocks` | 새 블록 채굴 🔒 |
| POST | `/peers` | 피어 연결 (`{"peer":"ws://host:port"}`) 🔒 |
| DELETE | `/peers` | 걸어 둔 피어 잊기 🔒 |
| DELETE | `/peers/banned` | 밴 풀기 🔒 |
| POST | `/transactions` | 송금 (`{"address":"m…","amount":300000000,"fee":1000}` 또는 `feeRate`) 🔒 |
| GET/POST | `/mining` | 자동 채굴 상태 / 켜기·끄기 (`{"enabled":true}`) 🔒 |
| POST | `/rpc` | 비트코인 호환 JSON-RPC (rpc.js). 지갑 메서드만 🔒 |
| GET  | `/me/balance` | 내 잔액 🔒 |
| GET  | `/me/address` | 지금 받는 주소 🔒 |
| POST | `/me/address` | 받는 주소를 새로 만든다 🔒 |
| GET  | `/me/addresses` | 지갑의 모든 주소와 잔액 🔒 |
| GET  | `/me/lockstatus` | 지갑 암호·잠금 상태 🔒 |
| POST | `/me/passphrase` | 지갑 파일 암호 걸기·바꾸기 🔒 |
| POST | `/me/unlock` | 잠긴 지갑 풀기 🔒 |
| POST | `/me/lock` | 다시 잠그기 🔒 |
| GET  | `/me/publickeys` | 다중서명에 쓸 공개키들 🔒 |
| POST | `/me/sign` | 한 입력 서명 (`{tx 또는 txId, publicKey}`) 🔒 |
| GET  | `/me/pending` | 아직 담기지 않은 내 보내기 🔒 |
| GET  | `/me/mnemonic` | 백업용 니모닉 🔒 |
| POST | `/me/restore` | 니모닉으로 지갑 복구 🔒 |


### transactions.js
트랜잭션 자료형과 검증, 합의 상수가 함께 산다.

1. TxIn / Transaction / TxOut 자료형, getTxId(txid 직렬화), signTxIn, getPublicKey
2. processTxs / validateTx 검증(UTxOut 참조·서명·스크립트·성숙도·lockTime)
3. createCoinbaseTx, isCoinbaseTx, isSpendable(성숙도), isFinalTx(lockTime)
4. 정책 상수 — INITIAL_SUBSIDY, HALVING_INTERVAL, COINBASE_MATURITY, MAX_TXS_PER_BLOCK, MAX_BLOCK_BYTES, MIN_RELAY_FEE_RATE
5. getBlockSubsidy / getTotalSupply 발행량, getTxFee / getTxFeeRate / getTxSize
6. updateUTxOuts / collectConsumed / rollbackTxs UTxOut 색인 보조, isAddressValid / addressVersion

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
제네시스 블록(메인넷 `src/genesis.json`, 테스트넷 `src/genesis.testnet.json`)을
새로 만든다. 프리마인 니모닉은 콘솔에 출력하고, `--write-wallet` 을 주면 그
지갑을 `src/wallet.json` 에 담는다(커밋 금지).

### wallet.js
BIP32 HD 지갑(hdwallet.js 위에서 주소를 만든다). 지갑 파일은 `src/wallet.json`(0600).

1. initWallet / reload 지갑을 만들거나 읽어 들인다
2. getBalance / getWalletBalance 잔액, findAmountInUTxOuts / findExactMatch 쓸 출력 고르기
3. getReceiveAddress / getNewAddress / getChangeAddress / getAddresses 받는 주소 관리(GAP_LIMIT)
4. createTx 송금 만들기, getPublicKeys / signMessage 다중서명용
5. getMnemonic 백업, restoreFromMnemonic 복구
6. setPassphrase / unlock / lock 파일 암호(scrypt + AES-256-GCM), isEncrypted / isLocked

### keys.js
secp256k1 키·서명(Node `crypto`). 비압축 공개키, DER low-S 서명, 검증.
예전의 elliptic / crypto-js / bn.js 를 대신한다.

### serialization.js
트랜잭션·블록 헤더의 바이트 직렬화와 `sha256d`. txid 와 블록 해시가 여기서 나온다.
`encodeTx`/`decodeTx`, `encodeBlock`/`decodeBlock` 은 해제 데이터까지 담은 raw
hex — RPC 로 트랜잭션과 블록을 통째로 주고받을 때 쓴다(txid 미리보기와 별개다).

### rpc.js
비트코인 호환 JSON-RPC. `POST /rpc` 가 부른다. 안쪽 모듈을 그대로 두고 이름과
응답 모양만 비트코인 코어 관례에 맞춘 껍데기다. 메서드 29개, 오류 코드도 저쪽
것을 쓴다. 지갑 메서드는 토큰이 있어야 한다.

### address.js
Base58Check 주소(`RIPEMD160(SHA256(공개키))`), 망 버전 바이트, 예전 형식 호환.

### params.js
망 파라미터 — 제네시스 파일, 주소 버전, P2P 매직, 데이터 경로. `LIMCOIN_NETWORK`.
