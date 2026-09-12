const test = require("node:test");
const assert = require("node:assert");
const RateLimit = require("../src/rateLimit");

/*
 * express 형 req·res 를 흉내 낸다. 통과하면 next 가 불리고, 막히면
 * status(429) 뒤 send 로 끝난다.
 */
const fakeRes = () => {
  const res = {
    code: null,
    headers: {},
    sent: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.code = code;
      return this;
    },
    send(body) {
      this.sent = body;
      return this;
    }
  };
  return res;
};

const run = (mw, ip, count = 1) => {
  const results = [];
  for (let i = 0; i < count; i++) {
    const res = fakeRes();
    let nexted = false;
    mw({ ip, socket: { remoteAddress: ip } }, res, () => {
      nexted = true;
    });
    results.push({ nexted, res });
  }
  return results;
};

test("한도 안에서는 통과하고 넘치면 429 를 내려 준다", () => {
  const mw = RateLimit.middleware({ limit: 5, clock: () => 1000 });

  for (const result of run(mw, "10.0.0.1", 5)) {
    assert.ok(result.nexted);
  }
  const hit = run(mw, "10.0.0.1")[0];
  assert.ok(!hit.nexted);
  assert.equal(hit.res.code, 429);
  assert.ok(Number(hit.res.headers["Retry-After"]) >= 1);
});

test("IP 별로 따로 센다", () => {
  const mw = RateLimit.middleware({ limit: 2, clock: () => 1000 });

  for (const result of run(mw, "10.0.0.1", 2)) {
    assert.ok(result.nexted);
  }
  // 다른 IP 는 영향이 없다
  assert.ok(run(mw, "10.0.0.2")[0].nexted);
  assert.ok(!run(mw, "10.0.0.1")[0].nexted);
});

test("루프백은 세지 않는다 — 로컬 도구와 테스트를 막을 이유가 없다", () => {
  const mw = RateLimit.middleware({ limit: 1, clock: () => 1000 });
  for (const ip of RateLimit.LOOPBACK) {
    for (const result of run(mw, ip, 20)) {
      assert.ok(result.nexted, `루프백(${ip}) 은 막히면 안 된다`);
    }
  }
});

test("시간이 지나면 토큰이 다시 찬다", () => {
  let now = 1000;
  const mw = RateLimit.middleware({ limit: 2, clock: () => now });

  assert.ok(run(mw, "10.0.0.1", 2).every(r => r.nexted));
  assert.ok(!run(mw, "10.0.0.1")[0].nexted); // 바닥

  // 한도 2 / 60초 → 토큰 하나가 다시 차는 데 30초
  now += 31_000;
  assert.ok(run(mw, "10.0.0.1")[0].nexted);
});

test("한도 0 이면 끈다", () => {
  const mw = RateLimit.middleware({ limit: 0, clock: () => 1000 });
  for (const result of run(mw, "10.0.0.1", 100)) {
    assert.ok(result.nexted);
  }
});
