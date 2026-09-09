# 거래소 통합 가이드

거래소(또는 커스터디, 결제 처리자)가 LimCoin 을 붙일 때 필요한 것을 순서대로
적는다. 형식의 정확한 정의는 [SPEC.md](SPEC.md) 에 있다.

## 0. 먼저 알아야 할 것

- **이 체인은 아직 공개 해시레이트가 없다.** 지금 난이도는 노트북 한 대로
  체인을 다시 쓸 수 있는 수준이다. 아래 확인 수는 "해시레이트가 충분히 분산된
  뒤"를 전제로 한 값이고, 그 전에는 어떤 확인 수도 안전하지 않다.
  노드는 우리 끝에서 100블록보다 깊이 되감으라는 체인을 거부하지만
  (`LIMCOIN_MAX_REORG_DEPTH`), 그것은 임시 방편이지 해시레이트의 대체물이 아니다.
- 노드는 단일 구현(Node.js)이다. 다른 언어 구현이 없으므로 합의 버그가 곧
  체인 전체의 버그다.
- 테스트넷이 있다. 통합은 테스트넷에서 끝까지 해 보고 메인넷으로 가라.

## 1. 노드 띄우기

```bash
docker run -d --name limcoin \
  -p 3000:3000 -v limcoin:/data \
  -e LIMCOIN_NETWORK=testnet \
  -e LIMCOIN_WALLET=off \
  -e LIMCOIN_PEERS=ws://seed.example:3000 \
  ghcr.io/… (또는 docker build -t limcoin .)
```

- **`LIMCOIN_WALLET=off`** — 노드에 키를 두지 않는다. 이 프로세스가 뚫려도
  가져갈 것이 없다. 지갑 엔드포인트(`/me/*`, `POST /transactions`)는 503 을
  낸다. 송금은 4절의 raw 트랜잭션으로 한다.
- 채굴 노드를 같이 돌린다면 `LIMCOIN_MINING_ADDRESS` 로 보상을 콜드 주소로
  받는다. 그 주소의 키는 노드에 없어도 된다.
- 노드를 여러 대 두고 서로 `LIMCOIN_PEERS` 로 묶어 두면 한 대가 죽어도
  입금 감시가 서지 않는다.

상태 확인:

```
GET /health   → { ok, network, height, tipAge, peers, mempool, walletEnabled, uptime }
GET /metrics  → Prometheus (limcoin_height, limcoin_peers, limcoin_tip_age_seconds …)
```

`tipAge` 가 계속 커지면 블록이 안 들어오는 것이다 — 피어가 끊겼거나 망이 멈춘 것.

## 2. 주소

```
주소 = Base58Check( version ‖ RIPEMD160(SHA256(공개키)) )
mainnet version 0x30 ('L…'), testnet 0x6f ('m…' / 'n…')
```

- 사용자에게 입금 주소를 내줄 때는 **사용자마다 새 주소**를 만든다(HD 지갑,
  BIP32 non-hardened `m/0/i`). 그래야 입금이 누구 것인지 주소로 안다.
- 주소 유효성은 체크섬과 버전으로 확인한다. 참고 구현: `src/address.js`
  (`isBase58Address(addr, version)`). 다른 언어로 만들면 SPEC 2절의 비트코인
  벡터로 맞춰 보라.
- 예전 형식(공개키 hex 130자)도 유효한 주소지만 새로 내주지는 말라.

## 3. 입금 감시

권장 방식은 **블록을 순서대로 훑는 것**이다. 주소별 조회(`/address/:a/…`)는
편하지만 노드 색인에 기대므로, 원장은 블록에서 직접 세라.

```
1. 마지막으로 처리한 블록 해시 h 를 저장해 둔다 (처음엔 제네시스)
2. GET /blocks/since/h?limit=500  → { height, blocks }
3. 블록마다, 트랜잭션마다, 출력의 address 가 우리 사용자 주소면 입금 후보
4. 마지막 블록 해시로 h 를 갱신, blocks 가 비면 잠시 쉬고 2 로
```

**404 가 오면 h 가 밀려난 것이다(reorg).** 저장해 둔 것 중 충분히 오래된
(확인 수 이상 묻힌) 블록 해시로 돌아가 다시 훑고, 그 사이의 입금 후보는
취소한다. 그래서 확인 수를 채우기 전의 입금은 "보임" 상태로만 두고 잔액에
넣지 말라.

확인 수 `confirmations = 현재 높이 − 담긴 높이 + 1`. `GET /transactions/:id`
가 이 값을 준다(mempool 이면 `pending: true`, 0).

| 상황 | 권장 확인 수 |
|---|---|
| 일반 입금 | 20 (약 200초) |
| 코인베이스(채굴 보상) 출력 | 성숙도 10 은 프로토콜이 강제한다. 입금으로 인정은 20 |
| 해시레이트가 작은 동안 | 그 어떤 수도 안전하지 않다 — 소액만, 또는 수동 승인 |

블록 주기가 10초라 20확인이 비트코인 6확인보다 시간은 짧지만, 재구성 저항은
해시레이트에 달린 것이라 시간과 무관하다.

## 4. 출금 (raw 트랜잭션)

키는 거래소 시스템에 있고 노드는 서명된 것만 받는다.

```
1. GET /address/:from/utxos           → 쓸 수 있는 출력 목록
   coinbase: true 인 것은 height + 1 − blockIndex ≥ 10 인 것만 쓴다
2. GET /fees                          → perInput (입력 하나당 권장 수수료)
3. 트랜잭션을 만든다:
   txIns  = 고른 출력들 { txOutId, txOutIndex, publicKey: <그 주소의 공개키 hex> }
   txOuts = [{ address: 받는이, amount }, { address: 우리 거스름돈 주소, amount: 잔액 }]
   id     = sha256d(직렬화)            ← SPEC 3.1
4. 입력마다 signature = sign(개인키, id)   ← DER hex, low-S
5. POST /transactions/raw  (본문 = 트랜잭션 JSON)
   200 { id, pending: true }  /  400 "이유"
6. GET /transactions/:id 로 confirmations 를 추적한다
```

참고 구현(Node): `src/serialization.js` 의 `txIdOf`, `src/keys.js` 의 `sign`.
전체 흐름 예시가 `test/crypto.test.js` 와 아래에 있다.

```js
const Keys = require("./src/keys"), { txIdOf } = require("./src/serialization");
const tx = {
  txIns:  [{ txOutId, txOutIndex, publicKey: Keys.getPublicKey(priv), signature: "" }],
  txOuts: [{ address: to, amount }, { address: change, amount: utxo.amount - amount - fee }]
};
tx.id = txIdOf(tx);
tx.txIns[0].signature = Keys.sign(priv, tx.id);
// POST /transactions/raw  ← tx
```

- 수수료는 `Σ입력 − Σ출력` 이다. 별도 필드가 없다.
- 1000 lm(0.00001 LIM) 미만의 출력은 만들지 말라. 노드 지갑은 거절하고,
  받는 쪽도 쓸 때 입력 하나 값을 내야 해서 의미가 없다.
- 같은 UTxO 를 두 번 쓰는 트랜잭션은 mempool 이 거절한다. 출금 프로세스가
  둘이면 UTxO 를 나눠 써라.
- `POST /transactions/raw` 는 인증이 없다. 유효한 서명이 곧 권한이다.
  노드를 공개망에 두면 아무나 (유효한) 트랜잭션을 넣을 수 있지만, 그것은
  P2P 로도 되는 일이다.

## 5. 재구성(reorg) 정책

- 노드는 더 무거운 체인이 오면 갈라진 지점까지 되감고 갈아 끼운다(undo
  데이터). 밀려난 블록의 일반 트랜잭션은 mempool 로 돌아가 다시 담기고,
  코인베이스는 사라진다 — 그래서 성숙도가 있다.
- 거래소 쪽은 3절의 해시 기반 훑기로 이것을 자연스럽게 따라간다. 높이로
  훑으면 같은 높이의 다른 블록을 놓친다. **반드시 해시로.**
- 체인은 무게(블록마다 `2^256/(target+1)` 의 합, 10진 문자열)로 고른다.
  `GET /info` 의 `chainWork` 가 갑자기 줄면 노드가 갈아탄 것이다.
- 난이도는 블록마다 조정된다(LWMA). 해시레이트가 갑자기 빠져도 블록 시간은
  몇 분 안에 목표(10초)로 돌아온다. `GET /info` 의 `difficulty` 는 사람이 읽는
  값(바닥 = 1), `bits`/`target` 이 합의값이다.

## 5.5 콜드월렛과 수수료

**다중서명 콜드월렛.** 출금 키를 한 곳에 두지 않으려면 2-of-3 주소를 쓴다.

```bash
# 참여자마다 공개키를 낸다 (노드 지갑을 쓰면 GET /me/publickeys)
curl -X POST -H 'Content-Type: application/json' \
  -d '{"type":"multisig","m":2,"publicKeys":["04…","04…","04…"]}' \
  localhost:3000/script/address
# -> { address: "M…", redeemScript: "52…ae", asm: "OP_2 … OP_3 OP_CHECKMULTISIG" }
```

`redeemScript` 를 잃으면 그 주소의 코인을 영영 쓸 수 없다. 주소와 함께
보관할 것. 출금은 이렇게 만든다.

```bash
# 1) 쓸 출력을 고르고 서명하지 않은 트랜잭션을 만든다 (키를 쓰지 않는다)
curl -X POST -H 'Content-Type: application/json' \
  -d '{"inputs":[{"txOutId":"…","txOutIndex":0}],"outputs":[{"address":"L…","amount":100000000}]}' \
  localhost:3000/transactions/build
# -> { tx, signingHash, fee }
# 2) 참여자마다 signingHash 에 서명한다 (오프라인에서, 또는 POST /me/sign)
# 3) 서명을 공개키 순서대로 unlock 에 넣고 redeemScript 를 실어 보낸다
curl -X POST -H 'Content-Type: application/json' \
  -d '{"id":"…","txIns":[{"txOutId":"…","txOutIndex":0,"signature":"",
       "redeemScript":"52…ae","unlock":["<서명1>","<서명2>"]}],
       "txOuts":[…],"lockTime":0}' \
  localhost:3000/transactions/raw
```

서명 순서가 공개키 순서와 다르면 거부된다. 타임락(`timelock`)과
HTLC(`htlc`) 주소도 같은 방식으로 만든다 — 형식은 [SPEC 3.6](SPEC.md).

**수수료.** 바이트당으로 매긴다.

```bash
curl localhost:3000/fees
# { "perByte": 4, "typicalTx": { "bytes": 269, "fee": 1076 }, "congested": false, … }
```

- `POST /transactions` 에 `feeRate`(lm/byte)를 주면 크기에서 값을 뽑는다.
  `fee` 를 직접 줘도 된다. 둘 다 없으면 지금 권장값을 쓴다.
- 최소 릴레이 수수료는 4 lm/byte 다. 그보다 낮으면 mempool 이 받지 않는다.
- 묶여 버린 출금은 같은 출력을 쓰는 트랜잭션을 수수료를 올려 다시 보내면
  바꿔치기된다(RBF). 밀려나는 수수료 합에 자기 대역폭 값(크기 × 4)까지
  얹어야 받아 준다.

**핫월렛 잠그기.** 노드에 지갑을 두어야 한다면 파일에 암호를 건다.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"passphrase":"…"}' localhost:3000/me/passphrase
# 뜰 때 LIMCOIN_WALLET_PASSPHRASE 로 자동으로 풀거나, POST /me/unlock 으로 푼다
```

잠긴 동안에는 지갑 엔드포인트가 `423 Locked` 를 돌려준다. 가장 안전한 것은
여전히 `LIMCOIN_WALLET=off` 로 노드에 키를 두지 않는 것이다.

## 6. 운영

| 할 일 | 방법 |
|---|---|
| 백업 | 노드에는 키가 없다. 체인은 다시 받으면 된다. 백업할 것은 거래소 쪽 키다 |
| 업그레이드 | 컨테이너 교체. 체인·mempool 은 `/data` 볼륨에 남는다 |
| 망 확인 | `GET /info` 의 `network`, `genesisHash` 가 기대와 같은지 기동 시 확인 |
| 감시 | `limcoin_tip_age_seconds` 가 300 넘으면 경보, `limcoin_peers` 가 0 이면 경보 |
| 피어 | `LIMCOIN_PEERS` 로 최소 둘. 피어 발견이 나머지를 채운다 |

## 7. 체크리스트

- [ ] 테스트넷에서 입금 → 20확인 → 출금 → 확인 까지 자동화로 한 번
- [ ] 강제 reorg 시험: 노드 둘을 따로 채굴시켜 붙였을 때 입금 감시가 404 를 받고 되감는지
- [ ] 노드 재시작 뒤 `/blocks/since` 이어 받기
- [ ] 잘못된 주소(체크섬 틀림, 다른 망) 출금 요청이 거절되는지
- [ ] 키가 노드 컨테이너 밖에만 있는지 (`walletEnabled: false`)
