# LimCoin

비트코인 백서를 따라 만든 UTXO 블록체인 노드. Node.js, 의존성 최소.
학습용으로 시작했고, 지금은 거래소가 받아 돌릴 수 있는 모양을 목표로 한다.

| 리포 | |
|---|---|
| **LimCoin** (이 리포) | 노드 — 합의, P2P, 지갑, REST API |
| [LimCoin-Explorer](https://github.com/shing100/LimCoin-Explorer) | 블록 익스플로러 (React) |
| [LimCoin-Wallet](https://github.com/shing100/LimCoin-Wallet) | 데스크톱 지갑 (Electron, 노드 내장) |

| 문서 | |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | 프로토콜 명세 — 직렬화, 주소, 합의 규칙, P2P, API. 다른 언어로 만들 때 맞출 것 |
| [docs/EXCHANGE.md](docs/EXCHANGE.md) | 거래소 통합 — REST/JSON-RPC, 지갑 없는 노드, 입금 감시, raw 출금, reorg 정책 |
| [docs/HISTORY.md](docs/HISTORY.md) | 설계 기록 — 무엇이 왜 바뀌었나 |
| [docs/MODULES.md](docs/MODULES.md) | 모듈 지도 |

## 시작하기

```bash
yarn install
yarn test                                   # 282건, node:test (프레임워크 없음)
LIMCOIN_NETWORK=testnet node src/server.js  # 테스트넷 노드
```

Node 20 이상. 뜨면 지갑 토큰이 콘솔에 찍힌다(`LIMCOIN_WALLET_TOKEN` 으로 고정 가능).

```bash
T=<토큰>
curl localhost:3000/info
curl -X POST -H "Authorization: Bearer $T" localhost:3000/blocks          # 한 블록 채굴
curl -H "Authorization: Bearer $T" localhost:3000/me/balance
curl -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"address":"m…","amount":300000000,"fee":1000}' localhost:3000/transactions
```

채굴 보상은 **10블록이 쌓여야** 쓸 수 있다(코인베이스 성숙도). 금액은 전부
최소 단위 lm 정수다 (1 LIM = 100,000,000 lm).

### Docker

```bash
docker build -t limcoin .
docker run -p 3000:3000 -v limcoin:/data -e LIMCOIN_NETWORK=testnet limcoin
docker compose up          # 테스트넷 3노드: seed(채굴) + node-a + node-b(지갑 없음)
```

### 환경변수

| | |
|---|---|
| `LIMCOIN_NETWORK` | `mainnet`(기본) / `testnet`. 제네시스·주소 형식·P2P 매직이 갈린다 |
| `HTTP_PORT` | HTTP 와 P2P (같은 포트, WebSocket 업그레이드). 기본 3000 |
| `LIMCOIN_DATA_DIR` | 체인·mempool 저장 위치 (기본 `data/<망>/<포트>`) |
| `LIMCOIN_WALLET_TOKEN` | 지갑 API 토큰. `none` 이면 인증 끔(로컬 실습만) |
| `LIMCOIN_WALLET` | `off` 면 지갑 없이 뜬다 — 키를 밖에서 관리하는 노드 |
| `LIMCOIN_WALLET_FILE` | 지갑 파일 위치 (기본 `src/wallet.json`, 0600) |
| `LIMCOIN_MINING_ADDRESS` | 채굴 보상 받을 주소. 지갑 없이도 채굴할 수 있다 |
| `LIMCOIN_MINE` | `1` 이면 자동 채굴 |
| `LIMCOIN_MINER_THREADS` | 채굴 워커 수 (기본 코어 − 1) |
| `LIMCOIN_PEERS` | 뜰 때 붙을 피어. `ws://a:3000,ws://b:3000` |
| `LIMCOIN_PUBLIC_URL` | 남이 나에게 걸 수 있는 주소. 피어 발견에 쓴다 |

## 무엇이 들어 있나

**합의** — 백서 그대로의 UTXO 모델. 출력은 주소 하나(P2PKH)로도, 조건
(P2SH — 다중서명·타임락·HTLC)으로도 잠글 수 있다. 수수료(6장)와 210,000블록 반감기, 총량
4,200,000 LIM. 머클 트리와 SPV 증명(7·8장). 트랜잭션마다 새 키(10장, BIP32 HD
지갑 + BIP39 니모닉). 작업증명은 256비트 목표값(`bits`, 비트코인 nBits 형식)으로,
블록마다 LWMA 로 고친다 — 해시레이트가 요동하는 작은 체인에 맞는 방식이다. 블록의
`bits` 는 그 높이의 기대값과 같아야 하고 해시는 목표값 이하여야 한다. 타임스탬프는
직전 11블록 중앙값 초과, +2시간 이내. 코인베이스는 10블록 성숙. 체인은 무게(블록마다
`2^256/(target+1)` 의 합)로 고른다.

**형식** — 트랜잭션·헤더는 바이트 단위로 직렬화하고 `sha256d` 한다. 주소는
`Base58Check(version ‖ RIPEMD160(SHA256(공개키)))`, 메인넷 `L…` / 테스트넷 `m…`.
서명은 secp256k1 DER low-S. 암호는 전부 Node 내장 `crypto`. → [SPEC](docs/SPEC.md)

**노드** — 체인은 `blocks.jsonl`, mempool 은 `mempool.jsonl` 에 남는다(바뀌면 3초
뒤, 종료 신호에 즉시). UTxOut 집합은 `chainstate.json` 에 스냅샷으로 남아, 다시
뜰 때 체인을 전부 재검증하지 않는다(200블록·서명 567건 기준 388ms → 45ms).
**메모리에는 헤더만 둔다** — 블록 본문은 필요할 때 그 줄만 디스크에서 읽고 최근
것만 캐시한다(`LIMCOIN_BLOCK_CACHE`). 재구성은 블록마다 적어 둔 undo 데이터로
갈라진 깊이만 되감는다. 조회는 색인(블록 해시·txid·주소별). 동기화는 헤더 먼저 받아 무게를
재고 더 무거울 때만 블록을 조각(500개/4MB)으로 받는다. 피어는 끊기면 백오프로
다시 걸고, 서로를 소개해 그물을 만든다. 채굴은 워커 풀에서 코어 수만큼.

**스크립트** — 최소 스택 기계. `m-of-n` 다중서명, `OP_CHECKLOCKTIMEVERIFY`
타임락, HTLC(해시 타임락). 주소는 조건의 해시(P2SH)라 조건이 아무리 길어도
34자다. `POST /script/address` 로 만들고 `POST /transactions/build` +
`POST /me/sign` 으로 여럿이 나눠 서명한다.

**지킴** — 피어 사이의 메시지는 X25519 로 키를 나눠 ChaCha20-Poly1305 로 싼다
(임시 키라 전방 비밀성이 있고, 노드 신원은 Ed25519 로 고정할 수 있다).
피어가 잘못하면 점수를 매기고 100점이면 끊고 하루 동안 받지 않는다
(메시지 속도 제한 포함). 지갑 파일은 scrypt + AES-256-GCM 으로 잠글 수 있다.
우리 끝에서 100블록보다 깊이 되감으라는 체인은 무게와 무관하게 거부한다.

**API** — 읽기는 공개(CORS 허용), 지갑은 토큰. 외부에서 서명한 트랜잭션은
`POST /transactions/raw`. 입금 감시는 `GET /blocks/since/:hash`. `/health`,
`/metrics`(Prometheus). 권장 수수료 `GET /fees`. → [SPEC 7절](docs/SPEC.md#7-rest-api)

**JSON-RPC** — 같은 노드가 `POST /rpc` 로 비트코인 코어와 같은 메서드를 받는다
(`getblockcount`, `getblock`, `sendrawtransaction`, `gettxout`, `listunspent` …
29개). 이미 비트코인용으로 만들어 둔 거래소·결제 도구를 새로 짜지 않고 붙일 수
있다. 트랜잭션·블록은 raw hex 로도 오간다. → [SPEC 8절](docs/SPEC.md#8-json-rpc-비트코인-호환)

## 화폐 정책

| | |
|---|---|
| 최소 단위 | 1 LIM = 100,000,000 lm |
| 초기 블록 보조금 | 10 LIM |
| 반감기 | 210,000 블록마다 |
| 총 발행량 상한 | 약 4,200,000 LIM |
| 목표 블록 주기 | 10초 (블록마다 LWMA 조정, 창 60블록) |
| 블록당 트랜잭션 | 최대 100개 |
| 코인베이스 성숙도 | 10블록 |
| dust | 1000 lm 미만 출력은 만들지 않는다 |

제네시스 프리마인 10 LIM 의 니모닉은 생성 시 폐기했다. 아무도 쓸 수 없다.

## 거래소를 위해

노드에 키를 두지 않고(`LIMCOIN_WALLET=off`), 채굴 보상은 콜드 주소로
(`LIMCOIN_MINING_ADDRESS`), 출금은 밖에서 서명해 `POST /transactions/raw` 로,
입금은 해시 기반 `GET /blocks/since/:hash` 로 훑는다. 순서와 확인 수 권고,
reorg 정책, 체크리스트는 [docs/EXCHANGE.md](docs/EXCHANGE.md).

**아직 공개 해시레이트가 없다.** 지금 난이도는 노트북 한 대로 체인을 다시 쓸 수
있는 수준이다. 코드가 갖춰졌다는 것과 망이 안전하다는 것은 다른 이야기다 —
테스트넷에 채굴자와 노드가 모이는 것이 다음 관문이다.

## 개발

```bash
yarn test                    # 전체 282건
yarn lint                    # eslint — 오타 전역, 안 쓰는 변수, 삼킨 예외
yarn coverage                # 줄·분기 커버리지
yarn fuzz                    # 퍼징만. LIMCOIN_FUZZ_SEED 로 씨앗을 바꾼다
node --test test/sync.test.js
node scripts/generate-genesis.js --network testnet   # 제네시스 다시 만들기 (모든 노드가 공유해야 한다)
```

테스트는 Node 내장 `node:test` 로 282건. 실제로 nonce 를 찾아 블록을 만들고
(`test/helpers.js`), 두세 노드를 띄워 동기화·reorg·피어 발견을 확인하는 식이다.
암호 기본 요소는 외부 벡터(비트코인 주소, secp256k1 G, sha256d)로 맞춘다.
줄 커버리지는 93%.

`test/fuzz.test.js` 는 반대 방향이다 — 씨앗을 고정한 난수를 잔뜩 넣고 "어떤
입력이 와도 성립해야 하는 것"만 본다: 남이 보낸 것을 다루는 자리(P2P 메시지,
스크립트, raw 디코더, 주소, RPC)는 던지지 않는다, 왕복은 제자리로 돌아온다,
목표값이 쉬워지면 일한 양이 준다. 실제로 raw 디코더의 왕복이 깨지는 자리를
여기서 찾았다.

CI(GitHub Actions)는 Node 20·22·24 에서 린트·테스트·커버리지를 돌리고,
퍼저는 씨앗 셋으로 따로 돌리고, 컨테이너를 실제로 띄워 블록 하나를 만들어
본다.

무엇을 왜 바꿨는지는 [docs/HISTORY.md](docs/HISTORY.md) 에 있다. 짧게는 —
2018년 코드는 Linux 에서 뜨지 않았고, 서명 검증이 죽은 코드였고, 제네시스
개인키가 커밋돼 있었고, P2P 메시지 한 줄로 죽었고, 작업증명을 검증하지 않았다.

## 한계

- 단일 구현. 합의 버그가 곧 체인의 버그다. 다른 언어 구현이 맞춰 볼 수 있게
  [SPEC.md](docs/SPEC.md) 를 규범으로 적어 두었다.
- 헤더 동기화는 갈라진 부분의 해시를 메모리에 둔다(10만 블록 ≈ 13MB).
- 외부 보안 감사를 받지 않았다.
- 공개 해시레이트가 없다. 코드보다 이쪽이 더 큰 관문이다.
