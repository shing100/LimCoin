# 기여하기

## 먼저

```bash
yarn install
yarn test      # 304건
yarn lint
```

Node 20 이상. 외부 테스트 프레임워크는 쓰지 않는다 — Node 내장 `node:test` 다.

## 무엇을 고치든

**합의를 바꾸는가?** 이 질문을 먼저 하라. 블록이나 트랜잭션이 유효한지를
판단하는 코드를 건드렸다면 그것은 하드포크다. 다른 노드는 안 바뀐 채로
돌고 있고, 그 순간 체인이 갈라진다.

합의에 해당하는 것: `blockchain.js` 의 검증 부분, `transactions.js` 의 유효
조건, `script.js`, `target.js`, `merkle.js`, `serialization.js` 의 직렬화,
`params.js` 의 값들, 제네시스.

이쪽을 일부러 바꾼다면 PR 에 **무엇이 왜 바뀌는지, 기존 노드는 어떻게 되는지**
를 적어라. `docs/vectors.json` 도 다시 써야 한다(아래).

## 규칙

**테스트 없이는 고치지 않는다.** 버그를 고쳤다면 그 버그를 재현하는 테스트가
같이 와야 한다. 고치기 전에는 실패하고 고친 뒤에는 통과하는 것으로.

**주석은 "왜"를 적는다.** 무엇을 하는지는 코드가 말한다. 왜 그렇게 했는지,
전에는 어떻게 했다가 무엇이 문제였는지를 적어라. 이 리포의 주석은 대체로
그렇게 되어 있다 — 그 결을 따라 주기 바란다.

**의존성은 늘리지 않는다.** 지금 런타임 의존성은 express, ws 정도다. 암호는
전부 Node 내장 `crypto` 를 쓴다. 새 패키지를 넣어야겠다면 PR 에 왜 직접 짜지
않는지를 적어라.

**언어.** 주석·문서·커밋 메시지는 한국어다. 코드의 식별자는 영어.

## 돌려 볼 것

```bash
yarn test                    # 전체
node --test test/sync.test.js
yarn lint                    # 0건이어야 한다
yarn coverage                # 새 코드가 안 돌고 있지 않은지
yarn fuzz                    # 씨앗을 바꿔서도: LIMCOIN_FUZZ_SEED=12345 yarn fuzz
node scripts/vectors.js --check   # 합의가 안 바뀌었는지
```

CI 가 Node 20·22·24 에서 같은 것을 돌리고, 컨테이너를 띄워 블록 하나를
만들어 본다.

## 합의 테스트 벡터

`docs/vectors.json` 은 "이 입력이면 이 답"을 박아 둔 파일이다. 다른 언어
구현이 맞춰 볼 것이고, 우리 쪽에서는 리팩터링이 규칙을 바꿔 버렸는지를 잡는다.

`node scripts/vectors.js --check` 가 실패했다면 둘 중 하나다.

1. **실수로 규칙을 바꿨다** → 코드를 고친다. 이게 대부분이다.
2. **일부러 바꿨다** → `node scripts/vectors.js` 로 다시 쓰고, PR 에 그것이
   하드포크라는 것을 적는다.

손으로 고치지 말 것. 값은 전부 코드에서 뽑는다.

## 라이브로 확인하기

단위 테스트가 통과해도 노드를 실제로 띄우면 다른 것이 나온다. 이 프로젝트의
버그 상당수가 그렇게 나왔다.

```bash
# regtest 노드 하나 (난이도가 낮아 바로 채굴된다)
LIMCOIN_NETWORK=regtest HTTP_PORT=3001 LIMCOIN_DATA_DIR=/tmp/lc-a \
  LIMCOIN_WALLET_FILE=/tmp/lc-a.json LIMCOIN_WALLET_TOKEN=t LIMCOIN_MINE=1 \
  node src/server.js

# 두 노드를 붙여 동기화·reorg 를 본다
docker compose up
```

## PR

- 하나의 PR 은 하나의 일. 리팩터링과 기능 추가를 섞지 말라.
- 무엇이 문제였고 어떻게 고쳤는지를 본문에 적는다. 진단이 곧 설계 근거다.
- 성능을 고쳤다면 **잰 값**을 적어라 ("빨라졌다" 말고 "388ms → 45ms").

## 어디부터 볼까

- [docs/MODULES.md](docs/MODULES.md) — 모듈 지도
- [docs/SPEC.md](docs/SPEC.md) — 규칙의 정확한 정의
- [docs/HISTORY.md](docs/HISTORY.md) — 무엇이 왜 바뀌었나. 새 코드를 짜기
  전에 읽으면 같은 실수를 두 번 하지 않는다
