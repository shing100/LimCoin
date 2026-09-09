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

| 망 | 종류 | version | 첫 글자 |
|---|---|---|---|
| mainnet | 공개키 (P2PKH) | `0x30` | `L` |
| mainnet | 스크립트 (P2SH) | `0x32` | `M` |
| testnet | 공개키 | `0x6f` | `m` 또는 `n` |
| testnet | 스크립트 | `0xc4` | `2` |

스크립트 주소는 공개키 대신 **조건(redeemScript)** 의 해시를 담는다.
`주소 = Base58Check( scriptVersion ‖ RIPEMD160(SHA256(redeemScript)) )`. 3.6 참고.

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
  "txOuts": [{ "address": "<주소>", "amount": 300000000 }],
  "lockTime": 0
}
```

스크립트 주소를 쓰는 입력은 `publicKey`/`signature` 대신 `redeemScript` 와
`unlock` 을 싣는다.

```json
{ "txOutId": "<hex 64>", "txOutIndex": 0, "signature": "",
  "redeemScript": "<hex>", "unlock": ["<hex>", "<hex>"] }
```

### 3.1 직렬화와 txid

```
varint 입력 수
입력마다:  32바이트 txOutId ‖ uint32 txOutIndex
varint 출력 수
출력마다:  varstr 주소 ‖ uint64 금액
uint32 lockTime

txid = sha256d(위 바이트)
```

**서명과 공개키는 들어가지 않는다.** txid 는 "무엇을 어디로"만 덮으므로 서명
바이트가 바뀌어도 txid 는 같다(malleability 없음). 코인베이스의 빈 `txOutId`
는 0 32바이트로 직렬화한다.

해제 데이터(`signature`, `publicKey`, `redeemScript`, `unlock`)는 어느 것도
들어가지 않는다.

예: 입력 `ab×32 : 1`, 출력 `"LimAddr"` 1000 lm, lockTime 0 →
`01 ab…ab 01000000 01 07 4c696d41646472 e803000000000000 00000000`

### 3.2 서명

각 입력의 `signature` = `sign(입력이 가리키는 출력 주소의 개인키, txid)`.
모든 입력이 같은 txid 에 서명한다(SIGHASH_ALL 만 있다).

### 3.3 유효 조건

1. `id == txid(직렬화)`
2. 모든 입력이 현재 UTxOut 집합(같은 블록의 앞선 트랜잭션이 만든 출력 포함)에 있고 한 블록 안에서 같은 outpoint 를 두 번 쓰지 않는다
3. 입력마다:
   - 주소가 예전 형식이면 그 공개키로, P2PKH 면 `publicKey` 가 그 주소의 해시와 맞고 그 공개키로 서명이 검증된다(low-S)
   - P2SH 면 `hash160(redeemScript)` 가 주소와 맞고, `unlock` 을 스택에 올린 뒤 `redeemScript` 를 돌려 참이 남는다 (3.6)
4. 참조한 출력이 코인베이스면 `쓰는 높이 − 만들어진 높이 ≥ 10` (성숙도)
5. 금액은 lm 양의 정수(uint64), `Σ입력 ≥ Σ출력`. 차액이 수수료
6. `lockTime` 이 만족되었다 (3.5)
7. 정책(합의 아님): 1000 lm 미만 출력은 지갑이 만들지 않는다(dust)

### 3.4 코인베이스

블록의 첫 트랜잭션. 입력 하나 `{ txOutId: "", txOutIndex: <블록 높이>, signature: "" }`,
출력 하나, 금액 = `보조금(높이) + 블록 안 수수료 합` 과 **정확히** 같아야 한다.
`lockTime` 은 0 이어야 한다.

### 3.5 lockTime

"이 높이(또는 시각)가 되어야 블록에 담길 수 있다". 0 이면 제한이 없다.

| lockTime | 뜻 | 담길 수 있는 조건 |
|---|---|---|
| `0` | 제한 없음 | 언제나 |
| `< 500000000` | 블록 높이 | `lockTime ≤ 그 블록의 높이` |
| `≥ 500000000` | 유닉스 시각 | `lockTime ≤ 그 블록의 MTP` |

시각은 채굴자의 시계가 아니라 직전 11블록의 중앙값(MTP)과 견준다 — 시계를
앞당겨 남의 타임락을 일찍 열지 못하게 한다. 비트코인은 `lockTime < 높이`
이지만 여기서는 `≤` 다(sequence 가 없어 끄는 길이 필요 없다).

### 3.6 스크립트 (P2SH)

출력에는 조건 대신 조건의 해시만 담는다. 쓸 때 원본(`redeemScript`)과 해제
데이터(`unlock`)를 함께 낸다.

```
검증 = hash160(redeemScript) == 주소의 해시
     그리고 run(unlock 을 스택에 올린 뒤 redeemScript) 의 결과가 참이고 스택에 값이 하나만 남는다
```

`unlock` 은 **데이터 배열**이다(hex 문자열). 연산자는 넣을 수 없다.
서명 대상은 언제나 `txid` 다.

**연산자**

| 코드 | 이름 | 하는 일 |
|---|---|---|
| `0x00` | `OP_0` | 빈 값(거짓)을 올린다 |
| `0x01`–`0x4b` | (직접 push) | 그 길이만큼 데이터를 올린다 |
| `0x4c` | `OP_PUSHDATA1` | 다음 1바이트가 길이 |
| `0x51`–`0x60` | `OP_1`–`OP_16` | 작은 수를 올린다 |
| `0x63` `0x64` `0x67` `0x68` | `OP_IF` `OP_NOTIF` `OP_ELSE` `OP_ENDIF` | 갈래 |
| `0x69` | `OP_VERIFY` | 참이 아니면 실패 |
| `0x75` `0x76` | `OP_DROP` `OP_DUP` | 버리기 / 복제 |
| `0x87` `0x88` | `OP_EQUAL` `OP_EQUALVERIFY` | 같은가 |
| `0xa8` `0xa9` | `OP_SHA256` `OP_HASH160` | 해시 |
| `0xac` `0xad` | `OP_CHECKSIG` `OP_CHECKSIGVERIFY` | 서명 확인 |
| `0xae` `0xaf` | `OP_CHECKMULTISIG` `OP_CHECKMULTISIGVERIFY` | m-of-n 서명 확인 |
| `0xb1` | `OP_CHECKLOCKTIMEVERIFY` | `tx.lockTime ≥ 스택 값` 인지 (단위도 같아야) |

`OP_CHECKMULTISIG` 은 `<m> <공개키…> <n>` 을 팝하고 서명 `m` 개를 팝한다.
비트코인의 "하나 더 버리는" 버그는 넣지 않았다. 서명은 공개키와 같은 순서여야
한다.

**한도** — 스크립트 1000바이트, push 520바이트, 스택 100, 연산자 200,
서명 검증 20회. 숫자는 최소 표기 리틀 엔디언 부호 있는 정수(최대 4바이트,
CLTV 만 5바이트).

**표준 꼴**

```
다중서명   <m> <pub…> <n> OP_CHECKMULTISIG
           해제: [sig…]  (공개키 순서대로 m 개)

타임락     <lockTime> OP_CHECKLOCKTIMEVERIFY OP_DROP OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG
           해제: [sig, pub]  + tx.lockTime ≥ lockTime

HTLC       OP_IF OP_SHA256 <hash> OP_EQUALVERIFY OP_DUP OP_HASH160 <받는쪽 pkh>
           OP_ELSE <lockTime> OP_CHECKLOCKTIMEVERIFY OP_DROP OP_DUP OP_HASH160 <보낸쪽 pkh>
           OP_ENDIF OP_EQUALVERIFY OP_CHECKSIG
           해제: 받는 쪽 [sig, pub, preimage, 01] / 보낸 쪽 [sig, pub, ""]
```

## 4. 블록

```json
{ "index", "hash", "previousHash", "timestamp", "merkleRoot", "difficulty", "nonce", "data": [tx…] }
```

### 4.1 헤더 직렬화 (88바이트) 와 블록 해시

```
uint32 version ‖ uint32 index ‖ 32B previousHash ‖ uint32 timestamp ‖ 32B merkleRoot ‖ uint32 bits ‖ uint64 nonce
hash = sha256d(헤더)
```

`version` 은 1. 규칙을 바꿀 때 채굴자가 새 값을 적어 찬성을 표시하는 자리다(BIP9 식).
`bits` 는 압축 목표값(4.3). `nonce` 는 uint64 — 채굴 중 2^32 를 넘을 수 있다.
제네시스의 `previousHash` 는 0 32바이트.

### 4.2 머클 루트

잎 = txid 바이트. 짝 = `sha256d(왼쪽 ‖ 오른쪽)`. 홀수면 마지막을 자기 자신과
짝짓는다(비트코인과 같다 — 같은 txid 가 한 블록에 두 번 있으면 거부해서
CVE-2012-2459 를 막는다). 잎이 하나면 그것이 루트.

### 4.3 유효 조건

| 규칙 | 값 |
|---|---|
| 작업증명 | `hash` 를 256비트 정수로 읽어(hex 그대로, 빅 엔디언) `target(bits)` **이하**, 그리고 `bits` 가 그 높이의 기대값과 **같다** |
| `bits` ↔ `target` | 비트코인 nBits 와 같다. `bits = 지수(1B) ‖ 가수(3B)`, `target = 가수 × 256^(지수−3)`. 가수의 첫 비트(0x00800000)는 음수 표시라 쓰지 않는다. 가수 0, 음수, `POW_LIMIT` 보다 큰 값은 무효 |
| `POW_LIMIT` (바닥) | `bits = 0x207fffff` → `target = 0x7fffff × 256^29` (≈2^255). 사람이 읽는 난이도 = `POW_LIMIT / target` (바닥 = 1) |
| 목표값 조정 (LWMA) | 블록마다. 처음 `lwmaWindow`(N=60) 블록은 제네시스의 `bits`. 그 뒤로 최근 N 블록의 풀이 시간 `s_i = ts_i − ts_{i−1}` 을 [1, 6T] 로 잘라 가중치 1..N(최근이 N)으로 합한다: `next = avg(target_i) × Σ(s_i·i) / (T·N(N+1)/2)`, T=10초. 결과는 `POW_LIMIT` 이하, 1 이상. `bits` 로 압축한 값이 기대값 |
| 최소 난이도 블록 (테스트넷·regtest) | 직전 블록보다 200초(20T) 넘게 뒤의 타임스탬프면 기대 `bits` 는 `POW_LIMIT`. LWMA 창 안에서 그런 블록(특별 블록: `bits = POW_LIMIT` 이고 200초 넘게 뒤)은 풀이 시간 T, 목표값은 직전 진짜 값으로 바꿔 넣는다(중립). 메인넷에는 없다 |
| 타임스탬프 | 직전 11블록의 중앙값(MTP) **초과**, 검증 노드 시계 +2시간 이하 |
| 연결 | `index = 직전+1`, `previousHash = 직전 hash` |
| 머클 | `merkleRoot = 머클루트(data)` |
| 본문 | 트랜잭션 ≤ 100건(코인베이스 포함), 첫 것이 코인베이스, 나머지가 3.3 을 순서대로 만족 |

### 4.4 발행

보조금 `10 LIM × 2^-⌊높이/210000⌋` (정수 나눗셈, 64회 반감 뒤 0). 총량은
4,200,000 LIM 으로 수렴. 코인베이스 성숙도 10블록.

### 4.5 체인 선택

무게 = `Σ (2^256 − target_i) / (target_i + 1) + 1` — 블록마다 목표값을 맞히는 데 드는
평균 해시 횟수의 합. 더 무거운 유효 체인이 이긴다. 같은 무게면 먼저 본 것.
API 와 P2P 에서는 10진 문자열로 나타낸다(64비트를 넘는다).

두 가지 제동이 있다(합의 규칙이 아니라 노드 정책이다).

| | |
|---|---|
| 체크포인트 | `params.checkpoints` 의 `[높이, 해시]`. 그 높이의 블록은 그 해시여야 한다 |
| 되감기 상한 | 우리 끝에서 `MAX_REORG_DEPTH`(기본 100)블록보다 깊이 되감으라는 체인은 거부. `LIMCOIN_MAX_REORG_DEPTH=0` 이면 끈다 |

되감기 상한은 값을 치른다: 그만큼 뒤처진 노드는 스스로 따라잡지 못한다.
공개 해시레이트가 적은 동안 "빌린 해시레이트로 처음부터 다시 캐기"를 막는
장치이고, 해시레이트가 충분해지면 필요 없다.

## 5. 망

| | mainnet | testnet | regtest |
|---|---|---|---|
| 주소 version | `0x30` | `0x6f` | `0x6f` |
| 제네시스 | `src/genesis.json` | `src/genesis.testnet.json` | 테스트넷 것 |
| P2P 매직 | `limcoin/main/1` | `limcoin/test/1` | `limcoin/regtest/1` |
| 기본 데이터 경로 | `data/mainnet/<port>` | `data/testnet/<port>` | `data/regtest/<port>` |
| 최소 난이도 블록 (4.3) | 없다 | 200초 넘게 비면 허용 | 허용 |
| LWMA 창 (4.3) | 60 | 60 | 8 |

regtest 는 한 기계에서 혼자 돌려 보는 망이다. 창이 작아 몇 블록 만에 조정이 도는 것을 볼 수 있다.

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

**못된 피어.** 잘못할 때마다 점수를 더하고 100점이면 끊은 뒤 그 주소를 하루
동안 받지 않는다.

| | 점수 |
|---|---|
| JSON 이 아니거나 모양이 어긋난 메시지 | 10 |
| 검증에서 떨어지는 블록·헤더 | 50 |
| 초당 50건(순간 200건) 초과 | 25 |
| 다른 망 | 100 (바로) |

달라고 한 적 없는 응답, 우리가 이미 더 무거워 접는 동기화 같은 것은 벌하지
않는다. `GET /peers/banned` 로 보고, `DELETE /peers/banned`(토큰)로 푼다.

**전송 암호화.** 붙자마자 서로 임시 X25519 공개키를 보내고, 자기 신원키
(Ed25519)로 그 임시 키에 서명한다. 임시 키끼리 ECDH 한 비밀을 HKDF 로 늘려
방향마다 다른 키를 뽑고, 그 뒤 모든 메시지를 ChaCha20-Poly1305 로 싼다.

```
HANDSHAKE  { v: 1, network, id: <ed25519 pub hex>, eph: <x25519 pub hex>,
             sig: <ed25519("limcoin/transport/1|<network>|<eph>")> }
ENC        { n: <번호>, c: <ChaCha20-Poly1305(JSON) ‖ 태그> }
```

- nonce 는 `0x00000000 ‖ uint64BE(번호)`. 번호는 방향마다 1씩 오르고, 받는
  쪽은 정확히 다음 번호만 받는다(재생·끼워넣기 차단).
- 임시 키는 연결마다 새로 만든다 — 신원키가 나중에 새도 지난 대화는 풀리지
  않는다(전방 비밀성).
- 신원키는 데이터 디렉터리의 `node_key`(0600). 그 공개키가 노드 id 이고,
  피어 주소에 `#<id>` 를 붙이면 그 노드가 맞는지 확인한다. 고정하지 않으면
  엿듣기는 막지만 중간자는 막지 못한다.

| `LIMCOIN_ENCRYPT` | |
|---|---|
| `optional`(기본) | 상대가 받아 주면 암호화한다. 1.5초 안에 핸드셰이크가 없으면 평문으로 (익스플로러 등) |
| `required` | 암호화하지 못하는 피어는 끊는다 |
| `off` | 하지 않는다 |

`wss://` 뒤에 두는 것도 여전히 좋다 — 그쪽은 인증서로 신원을 보증한다.

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

### 공개 (스크립트)

| | |
|---|---|
| `POST /script/address` | `{type: "multisig"|"timelock"|"htlc"|"raw", …}` → `{address, redeemScript, asm, script}` |
| `POST /script/decode` | `{redeemScript}` → 주소와 읽은 내용 |
| `POST /transactions/build` | `{inputs, outputs, lockTime}` → 서명하지 않은 트랜잭션과 서명 대상(txid) |
| `GET /peers/banned` | 한동안 받지 않기로 한 주소들 |
| `GET /peers/detail` | 피어마다 암호화 여부와 상대 노드 id |

### 공개 (쓰기)
| | |
|---|---|
| `POST /transactions/raw` | 서명된 트랜잭션 JSON. 유효하면 `{ id, pending: true }`, 아니면 400 과 이유 |

### 토큰 필요

지갑 파일에 암호가 걸려 있고 아직 풀지 않았으면 지갑 엔드포인트는 `423 Locked`
를 돌려준다.

| | |
|---|---|
| `GET /me/lockstatus` | `{encrypted, locked}` |
| `POST /me/passphrase` | 암호 걸기·바꾸기. 빈 값이면 푼다(평문으로) |
| `POST /me/unlock` | 잠긴 지갑 풀기 |
| `POST /me/lock` | 다시 잠그기(메모리에서 암호를 지운다) |
| `GET /me/publickeys` | 다중서명 주소를 만들 때 쓸 이 지갑의 공개키들 |
| `POST /me/sign` | `{tx \| txId, publicKey}` → 그 키로 한 서명 |
| | |
|---|---|
| `POST /blocks` | 한 블록 채굴 |
| `GET/POST /mining` | 자동 채굴 |
| `POST/DELETE /peers` | 피어 붙이기 / 잊기 |
| `/me/*`, `POST /transactions` | 노드 지갑 (LIMCOIN_WALLET=off 면 503) |

## 8. 환경 변수

| | |
|---|---|
| `LIMCOIN_NETWORK` | `mainnet`(기본) / `testnet` / `regtest` |
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
| `LIMCOIN_MAX_REORG_DEPTH` | 되감기 상한(기본 100). `0` 이면 상한 없음 |
| `LIMCOIN_MAX_MEMPOOL_BYTES` | mempool 바이트 상한(기본 5,000,000) |
| `LIMCOIN_MAX_MEMPOOL_TXS` | mempool 건수 상한(기본 5000) |
| `LIMCOIN_BLOCK_CACHE` | 메모리에 두는 블록 본문 수(기본 600). 나머지는 필요할 때 디스크에서 읽는다 |
| `LIMCOIN_ENCRYPT` | 전송 암호화 `optional`(기본) / `required` / `off` |
| `LIMCOIN_WALLET_PASSPHRASE` | 지갑 파일 암호. 뜰 때 자동으로 풀거나 걸 때 쓴다 |
