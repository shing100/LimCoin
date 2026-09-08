# LimCoin 프로토콜 명세

다른 언어로 노드나 지갑을 만들 때 맞춰야 하는 것을 전부 적는다. 여기 없는
것은 합의 규칙이 아니다. 예시 값은 `test/crypto.test.js` 의 벡터와 같다.

## 1. 기본 요소

| | |
|---|---|
| 해시 | `sha256d(x) = SHA256(SHA256(x))`. 표기는 hex 64자 |
| 서명 곡선 | secp256k1 ECDSA |
| 공개키 | 비압축 65바이트 `04 ‖ x ‖ y`, hex 130자 |
| 서명 | DER, hex. **S ≤ n/2 (low-S)** — high-S 는 무효 |
| 서명 대상 | 32바이트 txid. ECDSA 는 그 위에 SHA256 을 한 번 더 한 값에서 돈다 (`crypto.sign("sha256", txid바이트)`) |
| 정수 | 리틀 엔디언. `uint32`, `uint64` |
| 개수 | CompactSize varint: `<0xfd` 1바이트, `≤0xffff` `fd`+2, `≤0xffffffff` `fe`+4, 그 위 `ff`+8 |
| 문자열 | varint 길이 ‖ UTF-8 |
| 최소 단위 | 1 LIM = 100,000,000 lm. 금액은 항상 lm 정수 |

`sha256d("")` = `5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456`

## 2. 주소

```
주소 = Base58Check( version ‖ RIPEMD160(SHA256(공개키)) )
Base58Check(p) = Base58( p ‖ sha256d(p)[0..4) )
```

| 망 | version | 첫 글자 |
|---|---|---|
| mainnet | `0x30` | `L` |
| testnet | `0x6f` | `m` 또는 `n` |

버전이 다르면 그 망에서 무효다. 비트코인 벡터: 공개키
`0450863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b23522cd470243453a299fa9e77237716103abc11a1df38855ed6f2ee187e9c582ba6`
→ version `0x00` 로 `16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM`.

**예전 형식**: 비압축 공개키 hex 130자 그대로. 여전히 유효한 주소다. 이 주소의
코인을 쓸 때는 `txIn.publicKey` 가 없어도 된다(주소가 곧 공개키).

## 3. 트랜잭션

```json
{
  "id":     "<hex 64>",
  "txIns":  [{ "txOutId": "<hex 64>", "txOutIndex": 0, "publicKey": "<hex 130>", "signature": "<DER hex>" }],
  "txOuts": [{ "address": "<주소>", "amount": 300000000 }]
}
```

### 3.1 직렬화와 txid

```
varint 입력 수
입력마다:  32바이트 txOutId ‖ uint32 txOutIndex
varint 출력 수
출력마다:  varstr 주소 ‖ uint64 금액

txid = sha256d(위 바이트)
```

**서명과 공개키는 들어가지 않는다.** txid 는 "무엇을 어디로"만 덮으므로 서명
바이트가 바뀌어도 txid 는 같다(malleability 없음). 코인베이스의 빈 `txOutId`
는 0 32바이트로 직렬화한다.

예: 입력 `ab×32 : 1`, 출력 `"LimAddr"` 1000 lm →
`01 ab…ab 01000000 01 07 4c696d41646472 e803000000000000`

### 3.2 서명

각 입력의 `signature` = `sign(입력이 가리키는 출력 주소의 개인키, txid)`.
모든 입력이 같은 txid 에 서명한다(SIGHASH_ALL 만 있다).

### 3.3 유효 조건

1. `id == txid(직렬화)`
2. 모든 입력이 현재 UTxOut 집합(같은 블록의 앞선 트랜잭션이 만든 출력 포함)에 있고 한 블록 안에서 같은 outpoint 를 두 번 쓰지 않는다
3. 입력마다: 참조한 출력의 주소가 예전 형식이면 그 공개키로, 아니면 `publicKey` 가 그 주소의 해시와 맞고 그 공개키로 서명이 검증된다(low-S)
4. 참조한 출력이 코인베이스면 `쓰는 높이 − 만들어진 높이 ≥ 10` (성숙도)
5. 금액은 lm 양의 정수(uint64), `Σ입력 ≥ Σ출력`. 차액이 수수료
6. 정책(합의 아님): 1000 lm 미만 출력은 지갑이 만들지 않는다(dust)

### 3.4 코인베이스

블록의 첫 트랜잭션. 입력 하나 `{ txOutId: "", txOutIndex: <블록 높이>, signature: "" }`,
출력 하나, 금액 = `보조금(높이) + 블록 안 수수료 합` 과 **정확히** 같아야 한다.

## 4. 블록

```json
{ "index", "hash", "previousHash", "timestamp", "merkleRoot", "difficulty", "nonce", "data": [tx…] }
```

### 4.1 헤더 직렬화 (84바이트) 와 블록 해시

```
uint32 index ‖ 32B previousHash ‖ uint32 timestamp ‖ 32B merkleRoot ‖ uint32 difficulty ‖ uint64 nonce
hash = sha256d(헤더)
```

`nonce` 는 uint64 — 채굴 중 2^32 를 넘을 수 있다. 제네시스의 `previousHash` 는 0 32바이트.

### 4.2 머클 루트

잎 = txid 바이트. 짝 = `sha256d(왼쪽 ‖ 오른쪽)`. 홀수면 마지막을 자기 자신과
짝짓는다(비트코인과 같다 — 같은 txid 가 한 블록에 두 번 있으면 거부해서
CVE-2012-2459 를 막는다). 잎이 하나면 그것이 루트.

### 4.3 유효 조건

| 규칙 | 값 |
|---|---|
| 작업증명 | `hash` 의 앞자리 0 비트 ≥ `difficulty`, 그리고 `difficulty` 가 그 높이의 기대 난이도와 **같다** |
| 난이도 조정 | `index` 가 10의 배수인 블록 다음에. 그 블록과 10블록 앞 블록(`index−10`)의 타임스탬프 차이(=10블록이 걸린 시간)가 50초 미만이면 +1, 200초 초과면 −1(최소 1), 아니면 유지. 기준은 마지막 **진짜** 난이도(아래 특별 블록은 건너뜀). 목표 10초/블록 |
| 최소 난이도 블록 (테스트넷만) | 직전 블록보다 200초(목표의 20배) 넘게 뒤의 타임스탬프면 기대 난이도는 1 이다. 그 다음 블록은 특별 블록을 건너뛴 마지막 난이도로 돌아간다. 메인넷에는 없다 |
| 타임스탬프 | 직전 11블록의 중앙값(MTP) **초과**, 검증 노드 시계 +2시간 이하 |
| 연결 | `index = 직전+1`, `previousHash = 직전 hash` |
| 머클 | `merkleRoot = 머클루트(data)` |
| 본문 | 트랜잭션 ≤ 100건(코인베이스 포함), 첫 것이 코인베이스, 나머지가 3.3 을 순서대로 만족 |

### 4.4 발행

보조금 `10 LIM × 2^-⌊높이/210000⌋` (정수 나눗셈, 64회 반감 뒤 0). 총량은
4,200,000 LIM 으로 수렴. 코인베이스 성숙도 10블록.

### 4.5 체인 선택

무게 = `Σ 2^difficulty`. 더 무거운 유효 체인이 이긴다. 같은 무게면 먼저 본 것.

## 5. 망

| | mainnet | testnet |
|---|---|---|
| 주소 version | `0x30` | `0x6f` |
| 제네시스 | `src/genesis.json` | `src/genesis.testnet.json` |
| P2P 매직 | `limcoin/main/1` | `limcoin/test/1` |
| 기본 데이터 경로 | `data/mainnet/<port>` | `data/testnet/<port>` |
| 최소 난이도 블록 (4.3) | 없다 | 200초 넘게 비면 허용 |

`LIMCOIN_NETWORK` 로 고른다. 매직이 다른 피어는 `HELLO` 를 보고 끊는다.

## 6. P2P

WebSocket, 메시지는 JSON `{ "type", "data" }`. 한 메시지 ≤ 8MB.

| 메시지 | data | 뜻 |
|---|---|---|
| `HELLO` | `{ network, url }` | 붙자마자. 망 매직과 내 공개 주소(없으면 null) |
| `GET_LATEST` → `BLOCKCHAIN_RESPONSE` | `[끝 블록]` + 형제 필드 `work` | 새 블록 소식도 이것 |
| `GET_HEADERS {locator}` → `HEADERS_RESPONSE` | `{ headers, height }` | 아는 첫 해시 다음부터 헤더 ≤ 2000 |
| `GET_BLOCKS {locator}` → `BLOCKS_RESPONSE` | `{ blocks, height }` | 같은 자리부터 블록 ≤ 500 / 4MB |
| `REQUEST_MEMPOOL` → `MEMPOOL_RESPONSE` | `[tx]` | |
| `GET_PEERS` → `PEERS_RESPONSE` | `{ peers: [url] }` | ≤ 100 |

locator: 끝에서 10개는 하나씩, 그 뒤 간격을 두 배씩 늘려 제네시스까지의 해시.
동기화는 헤더 먼저(검증·무게 비교) → 더 무거울 때만 블록.

## 7. REST API

인증이 필요한 것은 `Authorization: Bearer <토큰>` (`LIMCOIN_WALLET_TOKEN`).

### 공개 (읽기)
| | |
|---|---|
| `GET /info` | 높이, 난이도, 발행량, mempool, 망, 제네시스 해시, 권장 수수료, 버전 |
| `GET /health` · `GET /metrics` | 상태 / Prometheus |
| `GET /blocks?limit&offset` | 최신순 한 페이지. `X-Total-Count` |
| `GET /blocks/since/:hash` | 그 블록 뒤의 블록들(≤500). 없으면 404 = 밀려남 |
| `GET /blocks/:hash` | |
| `GET /transactions` | mempool |
| `GET /transactions/:id` | 블록 안이든 mempool 이든. `confirmations`, `blockIndex` |
| `GET /transactions/:id/proof` | 머클 증명 |
| `GET /address/:a` · `/utxos` · `/transactions?limit&offset` | 잔액 / 미사용 출력(`blockIndex`,`coinbase` 포함) / 내역 |
| `GET /fees` | `{ perInput, congested, mempoolSize, blockCapacity }` |
| `GET /peers` · `GET /peers/known` | |
| `GET /search/:q` | 높이·해시·주소 판별 |

### 공개 (쓰기)
| | |
|---|---|
| `POST /transactions/raw` | 서명된 트랜잭션 JSON. 유효하면 `{ id, pending: true }`, 아니면 400 과 이유 |

### 토큰 필요
| | |
|---|---|
| `POST /blocks` | 한 블록 채굴 |
| `GET/POST /mining` | 자동 채굴 |
| `POST/DELETE /peers` | 피어 붙이기 / 잊기 |
| `/me/*`, `POST /transactions` | 노드 지갑 (LIMCOIN_WALLET=off 면 503) |

## 8. 환경 변수

| | |
|---|---|
| `LIMCOIN_NETWORK` | `mainnet`(기본) / `testnet` |
| `HTTP_PORT` | HTTP 와 P2P(같은 포트, WebSocket 업그레이드) |
| `LIMCOIN_DATA_DIR` | 체인·mempool 저장 위치 |
| `LIMCOIN_WALLET_TOKEN` | 지갑 API 토큰. `none` 이면 인증 끔(로컬만) |
| `LIMCOIN_WALLET` | `off` 면 지갑 없이 |
| `LIMCOIN_WALLET_FILE` | 지갑 파일 위치 |
| `LIMCOIN_MINING_ADDRESS` | 채굴 보상 받을 주소(지갑 없이 채굴) |
| `LIMCOIN_MINE` | `1` 이면 자동 채굴 |
| `LIMCOIN_MINER_THREADS` | 채굴 워커 수 |
| `LIMCOIN_PEERS` | 뜰 때 붙을 피어, 쉼표 구분 |
| `LIMCOIN_PUBLIC_URL` | 남이 나에게 걸 수 있는 주소 |
