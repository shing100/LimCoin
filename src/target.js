/**
 * 작업증명 목표값(target) — 256비트 정수와 그 압축 표기(bits), 그리고 다음 목표값.
 *
 * 예전에는 난이도가 "해시 앞에 붙어야 하는 0 비트 개수"(정수)였다. 한 칸이
 * 2배라 블록 시간이 목표의 절반과 두 배 사이를 오갔고, 10블록마다 한 칸씩만
 * 움직여 해시레이트 변화를 따라가지 못했다.
 *
 * 이제 비트코인처럼 256비트 목표값을 쓴다. 해시를 큰 정수로 읽어(hex 문자열
 * 그대로, 빅 엔디언) target 이하이면 통과다. 헤더에는 4바이트 압축 표기
 * `bits` 로 들어간다 — 비트코인의 nBits 와 같은 인코딩이다.
 *
 *   bits = 지수(1바이트) ‖ 가수(3바이트)
 *   target = 가수 × 256^(지수 − 3)
 *
 * 무게(work)는 "이 목표값을 맞히는 데 평균 몇 번 해시해야 하는가"로,
 * 2^256 / (target + 1) 이다. 체인의 무게는 그 합.
 *
 * 다음 목표값은 LWMA(Linearly Weighted Moving Average, zawy12)로 블록마다
 * 정한다. 최근 N 블록의 풀이 시간을 최근 것에 더 큰 가중치를 주어 평균하고,
 * 그 비율만큼 평균 목표값을 늘리거나 줄인다. 작은 체인은 해시레이트가 크게
 * 요동하므로(채굴자 하나가 들고 나가면 절반이 사라진다) 2016블록마다
 * 비율로 고치는 비트코인 방식보다 블록마다 고치는 쪽이 맞다 — Dogecoin
 * (DigiShield), Monero, 대부분의 소형 코인이 그렇게 한다.
 */

const MAX_256 = (1n << 256n) - 1n;

/*
 * 가장 쉬운 목표값(최소 난이도). 2^255 에 조금 못 미친다 — 해시 둘에 하나가
 * 통과하므로 어떤 기계든 즉시 블록을 만들 수 있다. 테스트넷 특별 블록과
 * 새 체인의 바닥이 된다.
 */
const POW_LIMIT_BITS = 0x207fffff;

const bitLength = n => n.toString(2).length;

/* ------------------------------------------- 압축 표기 <-> 목표값 */

// bits -> target. 모양이 틀리면 null (음수 비트, 가수 0, 지수 범위 밖).
const targetFromBits = bits => {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) {
    return null;
  }
  const exponent = bits >>> 24;
  const mantissa = bits & 0x007fffff;
  if (bits & 0x00800000 || mantissa === 0 || exponent > 32) {
    return null;
  }
  if (exponent <= 3) {
    return BigInt(mantissa) >> BigInt(8 * (3 - exponent));
  }
  return BigInt(mantissa) << BigInt(8 * (exponent - 3));
};

// target -> bits. 가수가 3바이트라 뒷자리는 버려진다(비트코인과 같다).
const bitsFromTarget = target => {
  if (typeof target !== "bigint" || target <= 0n) {
    throw Error(`목표값이 아닙니다: ${target}`);
  }
  let size = Math.ceil(bitLength(target) / 8);
  let compact;
  if (size <= 3) {
    compact = Number(target << BigInt(8 * (3 - size)));
  } else {
    compact = Number(target >> BigInt(8 * (size - 3)));
  }
  // 가수의 첫 비트가 1이면 음수로 읽히므로 한 바이트 밀고 지수를 올린다
  if (compact & 0x00800000) {
    compact >>= 8;
    size += 1;
  }
  return ((size << 24) | compact) >>> 0;
};

const POW_LIMIT = targetFromBits(POW_LIMIT_BITS);

// 유효한 bits 인가: 모양이 맞고, 바닥(POW_LIMIT)보다 어렵거나 같다
const isValidBits = bits => {
  const target = targetFromBits(bits);
  return target !== null && target >= 1n && target <= POW_LIMIT;
};

/* ------------------------------------------- 무게 / 표시용 난이도 */

// 이 목표값을 맞히는 데 드는 평균 해시 횟수 = 2^256 / (target + 1)
const workOf = bits => {
  const target = targetFromBits(bits);
  if (target === null) {
    return 0n;
  }
  return (MAX_256 - target) / (target + 1n) + 1n;
};

// 사람이 읽는 난이도 = POW_LIMIT / target. 바닥이 1, 두 배 어려우면 2. 실수.
const difficultyOf = bits => {
  const target = targetFromBits(bits);
  if (target === null) {
    return 0;
  }
  return Number((POW_LIMIT << 20n) / target) / 2 ** 20;
};

// target 을 hex 64자로
const targetHex = bits => {
  const target = targetFromBits(bits);
  return target === null ? null : target.toString(16).padStart(64, "0");
};

/* ------------------------------------------- 해시가 목표를 만족하는가 */

// 해시 앞의 0 비트 개수 (hex 문자열)
const leadingZeroBits = hash => {
  let bits = 0;
  for (const ch of hash) {
    const nibble = parseInt(ch, 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += nibble < 2 ? 3 : nibble < 4 ? 2 : nibble < 8 ? 1 : 0;
    break;
  }
  return bits;
};

/*
 * 채굴 루프에서 해시마다 BigInt 를 만들면 해시 자체보다 느려질 수 있다.
 * 목표값의 앞자리 0 개수를 미리 세어 두면 대부분은 0 개수만 비교해 끝난다 —
 * 해시의 0 이 더 많으면 통과, 더 적으면 실패, 같을 때만 큰 수를 비교한다.
 */
const compileTarget = bits => {
  const target = targetFromBits(bits);
  if (target === null) {
    throw Error(`bits 가 유효하지 않습니다: ${bits}`);
  }
  return { target, zeros: 256 - bitLength(target) };
};

const hashMeetsCompiled = (hash, compiled) => {
  const zeros = leadingZeroBits(hash);
  if (zeros > compiled.zeros) {
    return true;
  }
  if (zeros < compiled.zeros) {
    return false;
  }
  return BigInt("0x" + hash) <= compiled.target;
};

const hashMeetsBits = (hash, bits) => {
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    return false;
  }
  const target = targetFromBits(bits);
  return target !== null && BigInt("0x" + hash) <= target;
};

/* ------------------------------------------- 다음 목표값 (LWMA) */

/*
 * chain 다음 블록의 bits.
 *
 *   T        목표 블록 간격(초)
 *   N        창 크기(블록). 처음 N 블록은 조정 없이 제네시스의 bits 를 쓴다
 *   isSpecial(i, chain)  테스트넷 특별 블록이면 true — 창 안에서 그 블록의
 *            목표값은 직전 블록 것으로, 풀이 시간은 T 로 바꿔 넣는다(중립).
 *            비트코인 테스트넷은 특별 블록을 그대로 평균에 넣어 난이도가
 *            무너진다.
 *
 * 풀이 시간은 [1, 6T] 로 자른다. 타임스탬프를 앞당겨 적어 풀이 시간을 음수로
 * 만들어도 1 이 되고(난이도가 올라가는 쪽 — 공격자 손해), 아무리 오래
 * 비어도 한 블록이 목표값을 6배 넘게 늘리지는 못한다.
 *
 * chain 은 끝에서 N+1 개만 있으면 된다(동기화 창). 높이는 index 로 본다.
 */
const nextTargetBits = (chain, { T, N, genesisBits, isSpecial = () => false }) => {
  const tip = chain[chain.length - 1];
  if (tip.index < N) {
    return genesisBits;
  }
  if (chain.length < N + 1) {
    throw Error(`목표값을 정하려면 블록 ${N + 1}개가 필요합니다 (${chain.length}개)`);
  }
  const k = BigInt((N * (N + 1)) / 2);
  let weightedSolvetimes = 0n;
  let sumTarget = 0n;
  let realTarget = targetFromBits(chain[chain.length - 1 - N].bits);
  for (let w = 1; w <= N; w++) {
    const i = chain.length - 1 - N + w;
    let solvetime = chain[i].timestamp - chain[i - 1].timestamp;
    let target = targetFromBits(chain[i].bits);
    if (isSpecial(i, chain)) {
      solvetime = T;
      target = realTarget;
    } else {
      realTarget = target;
    }
    solvetime = Math.max(1, Math.min(solvetime, 6 * T));
    weightedSolvetimes += BigInt(solvetime * w);
    sumTarget += target;
  }
  const avgTarget = sumTarget / BigInt(N);
  let next = (avgTarget * weightedSolvetimes) / (k * BigInt(T));
  if (next > POW_LIMIT) {
    next = POW_LIMIT;
  }
  if (next < 1n) {
    next = 1n;
  }
  return bitsFromTarget(next);
};

module.exports = {
  MAX_256,
  POW_LIMIT,
  POW_LIMIT_BITS,
  targetFromBits,
  bitsFromTarget,
  isValidBits,
  workOf,
  difficultyOf,
  targetHex,
  leadingZeroBits,
  compileTarget,
  hashMeetsCompiled,
  hashMeetsBits,
  nextTargetBits
};
