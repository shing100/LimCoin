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
| `LIMCOIN_MINER_THREADS` | 채굴 워커 수 (기본: 코어 수 - 1) |

### 체인 동기화: 헤더 먼저, 조각으로

새 블록 소식(`BLOCKCHAIN_RESPONSE`)에는 보낸 쪽 체인의 **무게**(`work`)가
함께 실린다. 우리 끝에 바로 이어지면 붙이고, 이어지지 않는데 상대가 더
무겁다고 하면 동기화를 시작한다. 예전에는 **높이**로 판단해서 더 짧지만
더 무거운 체인(난이도가 높은)은 소식을 들어도 받지 않았다 — 체인을 고르는
기준은 높이가 아니라 일한 양이다(백서 4장).

두 단계다.

1. **헤더** (`GET_HEADERS`) — 본문 없는 블록, 300바이트쯤. locator 로 공통
   지점을 찾아 2000개씩 받으며 검증한다(작업증명, 난이도, 타임스탬프,
   연결). 다 받은 뒤 무게를 직접 잰다. 우리보다 무겁지 않으면 여기서 끝 —
   블록을 내려받는 값을 쓰지 않는다. 받는 동안 들고 있는 것은 마지막 32개
   헤더(검증에 필요한 만큼), 누적 무게, 해시 목록뿐이다 — 헤더 객체를 전부
   쌓아 두면 10만 블록에 40MB 쯤이 된다.
2. **블록** (`GET_BLOCKS`) — 무거울 때만. 갈라진 지점 다음부터 500블록 /
   4MB 이내로 받는다. 헤더에서 보지 못한 블록이 오면 버린다.

| 블록 묶음이 | 하는 일 |
|---|---|
| 우리 끝에 그대로 이어진다 | 하나씩 바로 붙인다. 쌓아 두지 않으므로 제네시스부터 받는 새 노드도 메모리가 늘지 않는다 |
| 갈라진 지점부터 온다 | 다 받은 뒤 한 번에 갈아 끼운다. 조각마다 하면 아직 무게가 모자라 거부된다 |

예전에는 `GET_ALL` 한 번에 체인 전체가 한 메시지로 왔다. 메시지 상한이
8MB 이므로 **체인이 그보다 커지는 순간 새 노드는 동기화 자체를 못 했다.**

locator 는 끝에서 열 개는 하나씩, 그 뒤로는 간격을 두 배씩 늘려 제네시스까지
담는다. 얕은 갈래는 정확히 잡고 깊은 갈래도 O(log n) 개로 덮는다.

### 피어

```bash
LIMCOIN_PEERS=ws://a:3000,ws://b:3000 node src/server.js   # 뜰 때 붙을 피어
curl -X POST   -H "Authorization: Bearer $TOKEN" -d '{"peer":"ws://c:3000"}' localhost:3000/peers
curl -X DELETE -H "Authorization: Bearer $TOKEN" -d '{"peer":"ws://c:3000"}' localhost:3000/peers
```

우리가 건 연결이 끊기면 **다시 건다.** 실패할 때마다 간격을 두 배로 늘려
(1초 → 60초 상한) 상대가 죽어 있는 동안 도배하지 않는다. 예전에는 한 번
끊기면 그걸로 끝이었다 — 상대가 재시작하는 동안 우리는 조용히 혼자가 됐다.
`DELETE /peers` 로 잊으면 재연결도 멈춘다.

**피어가 피어를 알려 준다** (비트코인의 `addr` 교환). 붙으면 자기 공개
주소를 알리고(`HELLO`), 아는 피어 목록을 주고받는다(`GET_PEERS`). 새로 알게
된 주소에는 outbound 상한(8)까지 알아서 붙는다. 한 노드만 알고 시작해도
그물이 이어진다.

```bash
LIMCOIN_PUBLIC_URL=ws://203.0.113.5:3000   # 남이 나에게 걸 수 있는 주소
curl localhost:3000/peers/known             # 배웠지만 아직 붙지 않은 것까지
```

공개 주소는 스스로 알 수 없다(들어온 연결에서 보이는 것은 상대의 임시
포트다). 없으면 남의 주소를 배우기만 하고 우리를 알리지는 못한다. 서로를
동시에 알게 되어 양쪽이 동시에 걸면 소켓이 둘이 되는데, 공개 주소가
사전순으로 앞선 쪽이 자기가 건 것을 남기는 규칙으로 하나를 끊는다.

`POST /peers` 는 지갑 토큰이 필요하다. 예전에는 아무나 이 노드를 임의의
주소에 연결시킬 수 있었다 — 피어 상한을 쓰레기로 채우거나 악성 피어에
붙여 놓을 수 있었다.

### 피어가 보낸 것은 믿지 않는다

P2P 로 들어오는 것은 전부 남이 보낸 바이트다. 예전에는
`BLOCKCHAIN_RESPONSE` 의 본문이 배열인지 보지 않아서

```
{"type":"BLOCKCHAIN_RESPONSE","data":123}
```

**이 한 줄이면 노드가 죽었다.** `123[NaN]` 이 `undefined` 가 되고 그것의
`.index` 를 읽다가 TypeError 가 나는데, `ws` 의 message 핸들러에서 던진
예외는 아무도 받지 않으므로 프로세스가 그대로 종료된다. 아무나 P2P 포트에
붙어 한 번 보내면 그 노드는 내려갔다.

두 겹으로 막는다. 모양을 먼저 보고, 그래도 남는 것은 `try` 로 가둔다.
한 피어가 보낸 것이 노드를 죽여서는 안 된다 (`test/p2p.test.js`).

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

### mempool 저장

아직 블록에 담기지 않은 트랜잭션은 `mempool.jsonl` 에 남긴다. 예전에는
메모리에만 있어서, 노드를 재시작하면 대기 중이던 트랜잭션이 그대로
사라졌고 보낸 사람은 영문도 모른 채 다시 보내야 했다. 비트코인 코어도
같은 이유로 `mempool.dat` 를 쓴다.

mempool 이 바뀌면 3초 뒤에, 그리고 종료 신호(SIGINT/SIGTERM)를 받으면
바로 저장한다. `kill -9` 로 죽어도 잃는 것은 마지막 몇 초 분량이다.
다시 뜰 때는 그대로 믿지 않고 UTxOut 집합에 대고 다시 검증한다 — 그동안
블록에 담겼거나 다른 트랜잭션이 같은 UTxO 를 써 버렸을 수 있다.

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

채굴은 **워커 스레드**에서 돈다(`src/pow-worker.js`). 메인 스레드는 아예
손대지 않으므로 채굴 중에도 HTTP 응답이 밀리지 않는다 — 채굴 중 `GET /info`
평균 1.4ms 를 확인했다.

워커를 여러 개 띄워 nonce 공간을 나눈다. 워커 k 는 k 부터 시작해 워커
수만큼씩 건너뛰므로 서로 겹치지 않는다. 개수는 `LIMCOIN_MINER_THREADS`
로 정하고, 기본은 `코어 수 - 1` 이다(메인 스레드 몫을 남긴다).

워커는 **풀로 살려 두고 일감만 보낸다.** 블록마다 새로 띄우면 띄우는 값이
채굴 시간보다 커질 수 있다 — 4코어에서 재 보니 워커 4개가 2개보다 느렸다.

```
난이도 15, 8블록 (워커 풀)
  1개 241ms/블록   2개 163ms   3개 103ms   4개 171ms
```

다른 노드가 먼저 블록을 올리면 워커에 중단 신호를 보내 헛돌지 않게 한다.

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

### 같은 블록 안에서 이어 쓰기

앞선 트랜잭션이 만든 출력을 뒤 트랜잭션이 쓸 수 있다(in-block chaining).
확인을 기다리지 않고 연달아 보내는 것이 여기 해당한다.

- 블록을 검증하는 동안 색인을 트랜잭션마다 갱신한다
- mempool 도 확정된 UTxOut 에 더해 mempool 이 만든 출력을 본다
- 블록에 담을 때 부모가 자식보다 먼저 오도록 정렬하고, 자리가 모자라면
  그 갈래를 통째로 뺀다 (부모 없는 자식만 담기면 그 블록은 거부된다)
- **지갑도 mempool 이 만든 출력을 쓴다.** 예전에는 확정된 것만 보고 골라서,
  방금 보내고 남은 거스름돈이 블록에 담길 때까지 묶였다 — 잔액이 있는데도
  "Not enough funds" 가 났다. 노드는 그런 트랜잭션을 받아 주는데 지갑이
  만들지를 못했다
- 수수료 합도 담기는 순서대로 센다(`sumBlockFees`). 블록 이전의 UTxOut 만
  보면 이어 쓴 입력이 "없는 출력"이 되어 수수료가 음수로 나오고, 코인베이스가
  보조금보다 적게 가져가는 블록을 만들어 스스로 거부하게 된다

### 체인 교체(reorg) 비용

우리 체인과 앞부분이 같으면 그 블록들은 이미 검증해 둔 것이다. 겹치는
만큼은 서명 검증을 건너뛴다 — reorg 비용을 결정하는 것은 서명 검증이다.

```
블록 300개 재검증
  전체 (서명 포함) 428ms  ->  접두사 건너뛰기 11ms   (39배)
```

겹치는 부분은 재생조차 하지 않는다. 블록마다 "이 블록이 걷어 낸 UTxOut"을
적어 두면(undo 데이터), 갈라진 블록만 되감아서 공통 지점의 상태를 얻을 수
있다. 주소 색인도 같은 방식으로 그 높이까지만 잘라 낸다.

```
체인 2000블록, 한 블록 갈라진 경우
  제네시스부터 재생  218ms  ->  undo 되감기 0.2ms
```

다만 교체된 체인의 앞부분은 *우리* 블록으로 채운다. 트랜잭션 id 는 서명을
덮지 않으므로 해시가 같으면서 서명 바이트만 다른 블록을 보낼 수 있다.
UTxOut 결과는 같지만 그걸 저장해 두면 남에게 거부당하는 블록을 갖게 된다.

### 코인베이스 성숙도

갓 만들어진 코인베이스 출력은 `COINBASE_MATURITY` 블록이 쌓여야 쓸 수 있다.

체인이 갈라져 그 블록이 밀려나면 코인베이스는 통째로 사라진다. 일반
트랜잭션은 mempool 로 되돌아가 다시 담기지만 코인베이스는 그럴 수 없다.
그것을 쓴 트랜잭션도 전부 무효가 되고, **그 코인을 받은 사람은 영문도
모르고 잃는다.**

비트코인은 100블록(약 16시간)을 기다리게 한다. 여기서는 **10블록**이다 —
블록 주기가 10초라 100이면 실습에서 17분을 기다려야 하고, 재구성 깊이가
보통 1~2인 것에 견주면 10도 충분히 깊다.

```
GET /me/balance
{ "balance": 확정, "spendable": 지금 쓸 수 있는, "immature": 아직 못 쓰는 }
```

UTxOut 은 만들어진 블록의 높이(`blockIndex`)와 코인베이스 여부를 함께
들고 다닌다. 그 둘이 없으면 "얼마나 깊이 묻혔는지"를 알 수 없다.

### 블록 타임스탬프

| | 예전 | 지금 |
|---|---|---|
| 하한 | 직전 블록 −60초 | 직전 11블록 타임스탬프의 **중앙값(MTP)** |
| 상한 | 내 시계 +60초 | 내 시계 **+2시간** |

둘 다 문제가 있었다.

- **뒤로 60초까지 갈 수 있었다.** 난이도는 타임스탬프 차이로 정해지므로
  (`timeTaken = 최신 − 10블록 전`) 시간을 뒤로 밀면 `timeTaken` 이 커져
  난이도가 내려간다. 블록을 조작해 난이도를 낮출 수 있었다
- **미래로는 60초까지만 허용했다.** 노드 사이 시계가 조금만 어긋나도
  정직한 블록이 거부된다 — 그것만으로 체인이 갈라진다

중앙값이라 과반을 쥐지 않으면 시간을 뒤로 밀 수 없다. 채굴할 때는
`max(지금, MTP + 1)` 을 쓴다 — 블록이 몇 초 안에 여러 개 나오면 시계가
같은 초를 가리켜 중앙값이 지금과 같아질 수 있기 때문이다.

### 작업증명 검증

블록이 내건 난이도가 그 높이에서 프로토콜이 정한 값과 같은지, 그리고
해시가 실제로 그 난이도를 만족하는지를 함께 본다.

둘 중 하나라도 없으면 `difficulty` 는 그냥 블록에 적힌 숫자다. 체인의
무게는 `2^difficulty` 의 합으로 재므로, 아무 해시에 `difficulty: 200` 을
적어 두면 정직한 체인을 단번에 넘어선다. 일 한 번 하지 않고 체인을 갈아
끼울 수 있는 셈이다. 난이도 계산은 *후보 체인의* 앞부분을 기준으로 한다 —
우리 체인만 보면 남이 보낸 체인의 난이도를 따질 수 없다.

### 조회 색인

블록 해시와 트랜잭션 id 로 어느 블록인지 바로 찾는다(`src/chainIndex.js`).
예전에는 조회가 전부 체인 훑기였다.

| | 예전 | 지금 |
|---|---|---|
| `GET /blocks/:hash` | 블록 전체 훑기 | 색인 조회 |
| `GET /transactions/:id` | 트랜잭션 전체 훑기 | 색인 조회 |
| `GET /search/:query` | 위 둘을 차례로 | 색인 조회 |
| `getTxProof(id)` | **블록마다 머클 트리를 새로 쌓기** | 그 블록 하나만 |

마지막 것이 특히 나빴다. 익스플로러에서 트랜잭션 페이지를 열 때마다
찾을 때까지 블록마다 머클 트리를 통째로 만들고 있었다.

`GET /transactions/:id` 는 아직 블록에 담기지 않은 트랜잭션(mempool)도
찾아 주고, 담겼으면 블록 높이와 확인 수(`confirmations`)를 함께 준다.

지갑용으로도 둘을 더했다.

| | |
|---|---|
| `GET /me/pending` | 아직 담기지 않은, 내 지갑이 얽힌 트랜잭션 |
| `GET /me/balance` | `balance`(확정) 와 `spendable`(mempool 반영) |

"얼마를 썼는가"는 입력이 가리키는 이전 출력을 되짚어야 알 수 있고 그건
UTxOut 집합을 가진 노드만 할 수 있다. 주소 색인이 블록에 대해 하는 일을
mempool 에 대해 하는 셈이라 응답 모양도 색인과 맞췄다.

### 권장 수수료

```
GET /fees   →  { perInput, congested, mempoolSize, blockCapacity }
GET /info   →  ... recommendedFeePerInput ...
```

블록에는 코인베이스를 뺀 99건이 수수료율(수수료 / 입력 수) 높은 순으로
담긴다. mempool 에 그보다 적으면 다음 블록에 자리가 있으니 바닥값
(1000 lm = dust)이면 되고, 넘치면 담기는 마지막 자리보다 1 lm 높아야 한다.
지갑은 이 값을 수수료 기본값으로 쓴다 — 예전에는 0.001 LIM 고정이었다.
비트코인 코어의 `estimatesmartfee` 처럼 과거 블록을 보는 것은 아니고 지금
mempool 만 본다.

### 폴링 비용

지갑과 익스플로러는 `/info` 를 4초마다 부른다. 그 한 번에 UTxOut 집합과
mempool 을 통째로 깊은 복사하고(`_.cloneDeep`), 수수료 합을 내려고
트랜잭션의 입력마다 UTxOut 배열을 훑고 있었다.

- 사본은 **얕은 복사**로 바꿨다. UTxOut 과 트랜잭션은 만들어진 뒤로
  아무도 고치지 않으므로(고치면 id 가 달라져 검증에서 떨어진다),
  막아야 할 것은 "밖에서 목록 자체를 건드리는 것"뿐이다
- 수수료 합과 주소별 잔액은 **색인을 한 번만 만들어** 돌려 쓴다

- 트랜잭션 수와 발행량은 체인을 훑지 않는다. 수는 색인이 알고, 발행량은
  반감기 구간별로 곱한다(최대 64번)

```
UTxOut 2만 개 사본        28.7ms  ->  0.12ms
mempool 500건 사본         1.8ms  ->  0.00ms
/info 수수료 합            mempool 500건 x UTxOut 2만개 훑기 -> 색인 조회
/info 트랜잭션 수/발행량   체인 전체 훑기 -> 색인 + 구간 계산
```

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

**어떤 출력을 쓸지(코인 선택)** — 세 단계로 고른다.

1. **정확히 채우는 조합**이 있으면 그것 (Branch and Bound). 잔돈 출력이
   필요 없다 — 트랜잭션이 작아지고 UTxOut 하나가 덜 생기며, 어느 출력이
   잔돈인지 밖에서 알아볼 수도 없다. 큰 것부터 깊이 우선으로 훑고, 남은
   것을 다 넣어도 모자란 갈래는 바로 접는다. 시도 횟수에 상한을 둔다.
2. 하나로 되는 출력이 있으면 그중 **가장 작은 것** — 입력 하나, 잔돈 최소.
3. 없으면 **큰 것부터** — 입력 수 최소.

예전에는 배열 순서대로 담아 큰 출력을 잘게 쪼개 잔돈을 남기기 일쑤였고,
그 잔돈이 쌓이면 다음 송금은 입력이 여러 개가 됐다. 여기서 수수료율은 입력
수로 재므로 입력이 많을수록 블록에 담기기도 불리하다.

**dust** — 1000 lm(0.00001 LIM) 미만의 출력은 만들지 않는다. 어떤 출력이든
나중에 쓸 때 입력 하나 값을 내므로, 그 값에도 못 미치는 잔돈은 있으나
없으나 같고 UTxOut 집합만 불린다. 그런 잔돈은 수수료로 넘기고, 그런 금액을
보내는 것도 거절한다.

**송금할 때마다 거스름돈은 새 주소로 받는다.** 나누지 않으면 거스름돈
주소가 곧 다음 받는 주소가 되어, 남에게 알려 준 주소와 거스름돈이 같은
것이 된다.

구현은 BIP32 공식 테스트 벡터로 검증한다(`test/hdwallet.test.js`).

씨앗은 **BIP39 니모닉 24단어**로 보관한다. 64자짜리 16진수는 사람이 옮겨
적기 어렵고 한 글자만 틀려도 지갑을 잃는다. 니모닉에는 체크섬이 있어
잘못 적으면 대개 걸리고, 단어 목록은 앞 네 글자만으로 서로 구별된다.

```bash
curl -H "Authorization: Bearer $TOKEN" localhost:3000/me/mnemonic
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mnemonic":"단어 24개"}' localhost:3000/me/restore
```

복구할 때 "어디까지 썼는지"는 니모닉에 들어 있지 않으므로 체인을 훑어
찾는다. 연속으로 20개(BIP44 의 gap limit)가 비어 있으면 거기서 멈춘다.

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
