/*
 * HTTP 레이트리밋.
 *
 * P2P 쪽에는 메시지 속도 제한과 점수·밴이 있지만, 공개 HTTP API 는 맨이었다.
 * 남이 아무리 자주 불러도 노드가 버티도록 IP 별 토큰버킷으로 줄을 세운다.
 *
 *   - 버킷 용량이 분당 상한이다. 처음엔 가득 차 있어 순간 몰아치기는 그만큼
 *     허용되고, 그 뒤로는 분당 limit 속도로 다시 찬다.
 *   - 루프백(127.0.0.1·::1)은 세지 않는다 — 로컬 도구와 테스트가 함께 쓰는
 *     자리이고, 레이트리밋의 목적은 바깥에서 오는 남의 요청을 줄 세우는 것.
 *   - 프록시 뒤에서는 X-Forwarded-For 로 진짜 IP 를 알아야 클라이언트별로
 *     정확히 센다. server.js 가 LIMCOIN_TRUST_PROXY 로 trust proxy 를 켠다.
 *
 * LIMCOIN_HTTP_RATE_LIMIT  분당 요청 상한. 기본 240. `0` 이면 끈다.
 */

const DEFAULT_LIMIT = 240;   // 분당 요청 수
const WINDOW_MS = 60 * 1000; // 버킷이 전부 다시 차는 주기
const MAX_TRACKED = 10_000;  // 기억할 IP 상한 — 공격자가 메모리를 먹지 못하게
const SWEEP_EVERY = 2_000;   // 이만큼 검사할 때마다 오래 쉰 항목을 걷는다

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const readLimit = () => {
  const parsed = Number.parseInt(process.env.LIMCOIN_HTTP_RATE_LIMIT, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_LIMIT;
};

/*
 * IP 별 버킷을 거친다. 통과하면 next, 넘치면 429 와 Retry-After 를 내려 준다.
 *
 * 토큰버킷 — 버킷은 초당 limit/60 씩 차오르고 용량이 limit 다. 순간 몰아침은
 * 버킷 용량까지 곧바로 통과시키고, 그 뒤로는 분당 속도로만 받는다.
 */
const middleware = (options = {}) => {
  const limit = options.limit !== undefined ? options.limit : readLimit();
  // 테스트에서 시계를 고정할 수 있게 둔다
  const clock = options.clock || Date.now;
  const refillPerMs = limit / WINDOW_MS;

  const buckets = new Map(); // ip -> { tokens, last }
  let checked = 0;

  // 두 창 동안 안 온 IP 는 버린다. 다시 오면 가득 찬 새 버킷으로 시작하므로
  // 지워도 뜻은 같다.
  const sweep = now => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.last > 2 * WINDOW_MS) {
        buckets.delete(key);
      }
    }
  };

  return (req, res, next) => {
    if (limit <= 0) {
      return next();
    }

    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "";
    if (LOOPBACK.has(ip)) {
      return next();
    }

    const now = clock();
    let bucket = buckets.get(ip);
    if (bucket === undefined) {
      bucket = { tokens: limit, last: now };
      buckets.set(ip, bucket);
    } else {
      bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.last) * refillPerMs);
      bucket.last = now;
    }

    checked += 1;
    if (checked % SWEEP_EVERY === 0) {
      sweep(now);
    }
    if (buckets.size > MAX_TRACKED) {
      const oldest = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last);
      for (const [key] of oldest.slice(0, buckets.size - MAX_TRACKED)) {
        buckets.delete(key);
      }
    }

    if (bucket.tokens < 1) {
      const waitMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
      res.set("Retry-After", String(Math.max(1, Math.ceil(waitMs / 1000))));
      return res.status(429).send("요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.");
    }

    bucket.tokens -= 1;
    return next();
  };
};

module.exports = { middleware, DEFAULT_LIMIT, LOOPBACK };
