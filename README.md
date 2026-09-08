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
| [docs/EXCHANGE.md](docs/EXCHANGE.md) | 거래소 통합 — 지갑 없는 노드, 입금 감시, raw 출금, reorg 정책 |
| [docs/HISTORY.md](docs/HISTORY.md) | 설계 기록 — 무엇이 왜 바뀌었나 |
| [docs/MODULES.md](docs/MODULES.md) | 모듈 지도 |

## 시작하기

```bash
yarn install
yarn test                                   # 170건, node:test (프레임워크 없음)
LIMCOIN_NETWORK=testnet node src/server.js  # 테스트넷 노드
```

Node 18 이상. 뜨면 지갑 토큰이 콘솔에 찍힌다(`LIMCOIN_WALLET_TOKEN` 으로 고정 가능).

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

**합의** — 백서 그대로의 UTXO 모델. 수수료(6장)와 210,000블록 반감기, 총량
4,200,000 LIM. 머클 트리와 SPV 증명(7·8장). 트랜잭션마다 새 키(10장, BIP32 HD
지갑 + BIP39 니모닉). 작업증명은 난이도가 그 높이의 기대값과 같고 해시가 그것을
만족해야 한다. 타임스탬프는 직전 11블록 중앙값 초과, +2시간 이내. 코인베이스는
10블록 성숙. 체인은 무게(`Σ 2^difficulty`)로 고른다.

**형식** — 트랜잭션·헤더는 바이트 단위로 직렬화하고 `sha256d` 한다. 주소는
`Base58Check(version ‖ RIPEMD160(SHA256(공개키)))`, 메인넷 `L…` / 테스트넷 `m…`.
서명은 secp256k1 DER low-S. 암호는 전부 Node 내장 `crypto`. → [SPEC](docs/SPEC.md)

**노드** — 체인은 `blocks.jsonl`, mempool 은 `mempool.jsonl` 에 남는다(바뀌면 3초
뒤, 종료 신호에 즉시). 재구성은 블록마다 적어 둔 undo 데이터로 갈라진 깊이만
되감는다. 조회는 색인(블록 해시·txid·주소별). 동기화는 헤더 먼저 받아 무게를
재고 더 무거울 때만 블록을 조각(500개/4MB)으로 받는다. 피어는 끊기면 백오프로
다시 걸고, 서로를 소개해 그물을 만든다. 채굴은 워커 풀에서 코어 수만큼.

**API** — 읽기는 공개(CORS 허용), 지갑은 토큰. 외부에서 서명한 트랜잭션은
`POST /transactions/raw`. 입금 감시는 `GET /blocks/since/:hash`. `/health`,
`/metrics`(Prometheus). 권장 수수료 `GET /fees`. → [SPEC 7절](docs/SPEC.md#7-rest-api)

## 화폐 정책

| | |
|---|---|
| 최소 단위 | 1 LIM = 100,000,000 lm |
| 초기 블록 보조금 | 10 LIM |
| 반감기 | 210,000 블록마다 |
| 총 발행량 상한 | 약 4,200,000 LIM |
| 목표 블록 주기 | 10초 (10블록마다 ±1 조정) |
| 블록당 트랜잭션 | 최대 100개 |
| 코인베이스 성숙도 | 10블록 |
| dust | 1000 lm 미만 출력은 만들지 않는다 |

제네시스 프리마인 10 LIM 의 니모닉은 생성 시 폐기했다. 아무도 쓸 수 없다.

## 거래소를 위해

노드에 키를 두지 않고(`LIMCOIN_WALLET=off`), 채굴 보상은 콜드 주소로
(`LIMCOIN_MINING_ADDRESS`), 출금은 밖에서 서명해 `POST /transactions/raw` 로,
입금은 해시 기반 `GET /blocks/since/:hash` 로 훑는다. 순서와 확인 수 권고,
reorg 정책, 체크리스트는 [docs/EXCHANGE.md](docs/EXCHANGE.md).

**아직 공개 해시레이트가 없다.** 난이도 15는 노트북 한 대로 체인을 다시 쓸 수
있는 수준이다. 코드가 갖춰졌다는 것과 망이 안전하다는 것은 다른 이야기다 —
테스트넷에 채굴자와 노드가 모이는 것이 다음 관문이다.

## 개발

```bash
yarn test                    # 전체
node --test test/sync.test.js
node scripts/generate-genesis.js --network testnet   # 제네시스 다시 만들기 (모든 노드가 공유해야 한다)
```

테스트는 Node 내장 `node:test` 로 170건. 실제로 nonce 를 찾아 블록을 만들고
(`test/helpers.js`), 두세 노드를 띄워 동기화·reorg·피어 발견을 확인하는 식이다.
암호 기본 요소는 외부 벡터(비트코인 주소, secp256k1 G, sha256d)로 맞춘다.

무엇을 왜 바꿨는지는 [docs/HISTORY.md](docs/HISTORY.md) 에 있다. 짧게는 —
2018년 코드는 Linux 에서 뜨지 않았고, 서명 검증이 죽은 코드였고, 제네시스
개인키가 커밋돼 있었고, P2P 메시지 한 줄로 죽었고, 작업증명을 검증하지 않았다.

## 한계

- 단일 구현. 합의 버그가 곧 체인의 버그다.
- P2P 는 암호화·인증 없는 WebSocket JSON. 피어 평판(ban score) 없음.
- 헤더 동기화는 갈라진 부분의 해시를 메모리에 둔다(10만 블록 ≈ 13MB).
- 외부 보안 감사를 받지 않았다.
