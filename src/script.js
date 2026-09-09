/**
 * 최소 스크립트 — 다중서명, 타임락, HTLC.
 *
 * 지금까지 출력을 잠그는 방법은 하나뿐이었다: "이 주소의 공개키로 서명하라"
 * (P2PKH). 그래서 다중서명 지갑도, 에스크로도, 조건부 지불도 만들 수 없었다.
 * 거래소 콜드월렛은 대개 다중서명을 요구한다.
 *
 * 비트코인의 P2SH 를 따른다. 출력에는 *조건 자체*가 아니라 조건의 해시만
 * 적는다.
 *
 *   주소   = Base58Check( scriptVersion || RIPEMD160(SHA256(redeemScript)) )
 *   쓸 때  = txIn.redeemScript(원본) + txIn.unlock(데이터들) 을 함께 실어 보낸다
 *   검증   = hash160(redeemScript) 가 주소와 맞는지 보고, unlock 을 스택에
 *            올린 뒤 redeemScript 를 돌려 마지막에 참이 남는지 본다
 *
 * 조건이 아무리 길어도 주소는 34자이고, 조건은 쓸 때가 되어서야 드러난다.
 *
 * unlock 은 데이터 배열(hex 문자열)이다 — 연산자는 넣을 수 없다. 비트코인은
 * scriptSig 에 연산자를 넣을 수 있어서 "push only" 규칙을 따로 두어야 했다.
 * 여기서는 형식 자체가 데이터만 허용하므로 그 문제가 없다.
 *
 * 서명 대상은 언제나 txid 다. txid 는 입력·출력·lockTime 을 덮고 서명과
 * 해제 데이터는 덮지 않는다(SIGHASH_ALL 하나뿐, malleability 없음).
 */
const crypto = require("crypto");
const Keys = require("./keys");
const { hash160 } = require("./address");

/* ------------------------------------------- 연산자 */

const OP = {
  FALSE: 0x00,
  PUSHDATA1: 0x4c,
  ONE: 0x51, // OP_1 .. OP_16 = 0x51..0x60
  SIXTEEN: 0x60,
  IF: 0x63,
  NOTIF: 0x64,
  ELSE: 0x67,
  ENDIF: 0x68,
  VERIFY: 0x69,
  DROP: 0x75,
  DUP: 0x76,
  EQUAL: 0x87,
  EQUALVERIFY: 0x88,
  SHA256: 0xa8,
  HASH160: 0xa9,
  CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad,
  CHECKMULTISIG: 0xae,
  CHECKMULTISIGVERIFY: 0xaf,
  CHECKLOCKTIMEVERIFY: 0xb1
};

const OP_NAME = Object.fromEntries(
  Object.entries(OP)
    .filter(([name]) => name !== "ONE" && name !== "SIXTEEN")
    .map(([name, code]) => [code, `OP_${name}`])
);
for (let n = 1; n <= 16; n++) {
  OP_NAME[OP.ONE + n - 1] = `OP_${n}`;
}

/* ------------------------------------------- 한도
 *
 * 스크립트는 남이 보낸 것을 우리가 돌려 준다. 한도가 없으면 검증 한 번에
 * 메모리와 CPU 를 얼마든지 쓰게 만들 수 있다(블록 하나로 망을 세우는 길).
 */
const MAX_SCRIPT_BYTES = 1000;
const MAX_PUSH_BYTES = 520;
const MAX_STACK = 100;
const MAX_OPS = 200;
const MAX_SIGOPS = 20;

// lockTime 이 이 값보다 작으면 블록 높이, 크면 유닉스 시각이다 (비트코인과 같다)
const LOCKTIME_THRESHOLD = 500000000;

/* ------------------------------------------- 스크립트 숫자
 *
 * 리틀 엔디언 부호 있는 정수, 최소 길이로 적는다. 같은 수를 두 가지로 적을
 * 수 있으면 같은 조건의 스크립트가 여러 해시를 갖게 된다.
 */
const encodeNum = value => {
  if (value === 0) {
    return Buffer.alloc(0);
  }
  const negative = value < 0;
  let abs = Math.abs(value);
  const bytes = [];
  while (abs > 0) {
    bytes.push(abs & 0xff);
    abs = Math.floor(abs / 256);
  }
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    bytes[bytes.length - 1] |= 0x80;
  }
  return Buffer.from(bytes);
};

const decodeNum = (buf, maxBytes = 4) => {
  if (buf.length === 0) {
    return 0;
  }
  if (buf.length > maxBytes) {
    throw Error(`스크립트 숫자가 ${maxBytes}바이트를 넘습니다`);
  }
  // 최소 표기인가: 마지막 바이트가 0x00/0x80 이면 그 앞이 이미 부호 비트를 썼어야 한다
  const last = buf[buf.length - 1];
  if ((last & 0x7f) === 0 && (buf.length === 1 || (buf[buf.length - 2] & 0x80) === 0)) {
    throw Error("스크립트 숫자가 최소 표기가 아닙니다");
  }
  let result = 0;
  for (let i = 0; i < buf.length; i++) {
    result += buf[i] * 2 ** (8 * i);
  }
  if (last & 0x80) {
    return -(result - (0x80 * 2 ** (8 * (buf.length - 1))));
  }
  return result;
};

// 스택 값의 참/거짓. 0, -0, 빈 값이 거짓이다.
const isTruthy = buf => {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) {
      return !(i === buf.length - 1 && buf[i] === 0x80);
    }
  }
  return false;
};

/* ------------------------------------------- 만들기 / 읽기 */

// 데이터 하나를 스택에 올리는 바이트열
const pushData = data => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "hex");
  if (buf.length > MAX_PUSH_BYTES) {
    throw Error(`한 번에 올릴 수 있는 데이터는 ${MAX_PUSH_BYTES}바이트까지입니다`);
  }
  if (buf.length === 0) {
    return Buffer.from([OP.FALSE]);
  }
  if (buf.length < 0x4c) {
    return Buffer.concat([Buffer.from([buf.length]), buf]);
  }
  return Buffer.concat([Buffer.from([OP.PUSHDATA1, buf.length]), buf]);
};

// 작은 수(0..16)는 한 바이트 연산자로, 그 밖에는 데이터로 올린다
const pushNum = value =>
  value >= 1 && value <= 16
    ? Buffer.from([OP.ONE + value - 1])
    : value === 0
      ? Buffer.from([OP.FALSE])
      : pushData(encodeNum(value));

// 조각들(Buffer | {op} | {data} | 숫자)을 이어 hex 스크립트로
const compile = parts =>
  Buffer.concat(
    parts.map(part => {
      if (Buffer.isBuffer(part)) {
        return part;
      }
      if (typeof part === "number") {
        return Buffer.from([part]); // 연산자 코드
      }
      if (part.num !== undefined) {
        return pushNum(part.num);
      }
      return pushData(part.data);
    })
  ).toString("hex");

/*
 * 스크립트를 연산 목록으로 읽는다. 잘린 push 같은 것은 여기서 걸린다.
 */
const parse = scriptHex => {
  if (typeof scriptHex !== "string" || !/^([0-9a-fA-F]{2})*$/.test(scriptHex)) {
    throw Error("스크립트가 hex 가 아닙니다");
  }
  const buf = Buffer.from(scriptHex, "hex");
  if (buf.length > MAX_SCRIPT_BYTES) {
    throw Error(`스크립트가 ${MAX_SCRIPT_BYTES}바이트를 넘습니다`);
  }
  const ops = [];
  let i = 0;
  while (i < buf.length) {
    const code = buf[i++];
    if (code === OP.FALSE) {
      ops.push({ code, data: Buffer.alloc(0), push: true });
    } else if (code < 0x4c) {
      if (i + code > buf.length) {
        throw Error("데이터가 잘렸습니다");
      }
      ops.push({ code, data: buf.subarray(i, i + code), push: true });
      i += code;
    } else if (code === OP.PUSHDATA1) {
      if (i >= buf.length) {
        throw Error("데이터가 잘렸습니다");
      }
      const length = buf[i++];
      if (i + length > buf.length) {
        throw Error("데이터가 잘렸습니다");
      }
      if (length > MAX_PUSH_BYTES) {
        throw Error("데이터가 너무 큽니다");
      }
      ops.push({ code, data: buf.subarray(i, i + length), push: true });
      i += length;
    } else if (code >= OP.ONE && code <= OP.SIXTEEN) {
      // OP_1..OP_16 도 결국 숫자를 올린다. 다만 표기는 연산자다.
      ops.push({ code, data: encodeNum(code - OP.ONE + 1) });
    } else if (OP_NAME[code] !== undefined) {
      ops.push({ code });
    } else {
      throw Error(`알 수 없는 연산자 0x${code.toString(16)}`);
    }
  }
  return ops;
};

// 사람이 읽는 형태 — 익스플로러와 오류 메시지용
const toAsm = scriptHex =>
  parse(scriptHex)
    .map(op =>
      op.push ? (op.data.length === 0 ? "0" : op.data.toString("hex")) : OP_NAME[op.code]
    )
    .join(" ");

/* ------------------------------------------- 실행 */

/*
 * unlock(데이터 배열)을 스택에 올린 뒤 redeemScript 를 돌린다.
 *
 * ctx: { txId, lockTime, spendHeight, medianTimePast }
 * 통과하면 true, 아니면 이유를 담은 Error 를 던지지 않고 false 를 돌려준다
 * (검증하는 쪽은 참/거짓만 알면 된다. 이유는 로그로 남긴다).
 */
const run = (unlock, redeemScriptHex, ctx) => {
  try {
    return evaluate(unlock, redeemScriptHex, ctx);
  } catch (e) {
    console.log(`스크립트 실행 실패: ${e.message}`);
    return false;
  }
};

const evaluate = (unlock, redeemScriptHex, ctx) => {
  if (!Array.isArray(unlock)) {
    throw Error("unlock 은 hex 문자열 배열이어야 합니다");
  }
  if (unlock.length > MAX_STACK) {
    throw Error("unlock 데이터가 너무 많습니다");
  }
  const stack = unlock.map(item => {
    if (typeof item !== "string" || !/^([0-9a-fA-F]{2})*$/.test(item)) {
      throw Error("unlock 항목이 hex 가 아닙니다");
    }
    const buf = Buffer.from(item, "hex");
    if (buf.length > MAX_PUSH_BYTES) {
      throw Error("unlock 항목이 너무 큽니다");
    }
    return buf;
  });

  const ops = parse(redeemScriptHex);
  // 조건문 상태. 각 원소는 이 갈래를 실행하는가.
  const branches = [];
  const executing = () => branches.every(Boolean);
  let opCount = 0;
  let sigOps = 0;

  const pop = () => {
    if (stack.length === 0) {
      throw Error("스택이 비었습니다");
    }
    return stack.pop();
  };
  const push = value => {
    stack.push(value);
    if (stack.length > MAX_STACK) {
      throw Error("스택이 너무 깊습니다");
    }
  };

  for (const op of ops) {
    const isBranchOp = op.code === OP.IF || op.code === OP.NOTIF || op.code === OP.ELSE || op.code === OP.ENDIF;
    if (!executing() && !isBranchOp) {
      continue;
    }
    if (op.data !== undefined) {
      push(op.data);
      continue;
    }
    if (++opCount > MAX_OPS) {
      throw Error(`연산자가 ${MAX_OPS}개를 넘습니다`);
    }
    switch (op.code) {
      case OP.IF:
      case OP.NOTIF: {
        if (!executing()) {
          branches.push(false);
          break;
        }
        const value = isTruthy(pop());
        branches.push(op.code === OP.IF ? value : !value);
        break;
      }
      case OP.ELSE: {
        if (branches.length === 0) {
          throw Error("짝 없는 OP_ELSE");
        }
        // 바깥 갈래가 꺼져 있으면 그대로 꺼 둔다
        const outer = branches.slice(0, -1).every(Boolean);
        branches[branches.length - 1] = outer && !branches[branches.length - 1];
        break;
      }
      case OP.ENDIF:
        if (branches.length === 0) {
          throw Error("짝 없는 OP_ENDIF");
        }
        branches.pop();
        break;
      case OP.VERIFY:
        if (!isTruthy(pop())) {
          throw Error("OP_VERIFY 실패");
        }
        break;
      case OP.DROP:
        pop();
        break;
      case OP.DUP: {
        const top = pop();
        push(top);
        push(top);
        break;
      }
      case OP.EQUAL:
      case OP.EQUALVERIFY: {
        const equal = pop().equals(pop());
        if (op.code === OP.EQUALVERIFY) {
          if (!equal) {
            throw Error("OP_EQUALVERIFY 실패");
          }
        } else {
          push(equal ? Buffer.from([1]) : Buffer.alloc(0));
        }
        break;
      }
      case OP.SHA256:
        push(crypto.createHash("sha256").update(pop()).digest());
        break;
      case OP.HASH160:
        push(hash160(pop()));
        break;
      case OP.CHECKSIG:
      case OP.CHECKSIGVERIFY: {
        if (++sigOps > MAX_SIGOPS) {
          throw Error(`서명 검증이 ${MAX_SIGOPS}번을 넘습니다`);
        }
        const publicKey = pop();
        const signature = pop();
        const ok = Keys.verify(publicKey.toString("hex"), ctx.txId, signature.toString("hex"));
        if (op.code === OP.CHECKSIGVERIFY) {
          if (!ok) {
            throw Error("OP_CHECKSIGVERIFY 실패");
          }
        } else {
          push(ok ? Buffer.from([1]) : Buffer.alloc(0));
        }
        break;
      }
      case OP.CHECKMULTISIG:
      case OP.CHECKMULTISIGVERIFY: {
        /*
         * <m> <공개키...> <n> OP_CHECKMULTISIG, 해제는 <서명...> m 개.
         *
         * 비트코인은 여기서 스택 하나를 더 버린다(초기 구현의 버그를 규칙으로
         * 굳힌 것). 우리는 호환할 옛 체인이 없으므로 넣지 않는다.
         * 서명은 공개키와 같은 순서여야 한다 — 순서를 자유롭게 하면 m×n 번
         * 검증하게 되어 CPU 를 낭비시킬 수 있다.
         */
        const n = decodeNum(pop());
        if (n < 1 || n > MAX_SIGOPS) {
          throw Error(`공개키 개수가 1..${MAX_SIGOPS} 가 아닙니다: ${n}`);
        }
        if ((sigOps += n) > MAX_SIGOPS) {
          throw Error(`서명 검증이 ${MAX_SIGOPS}번을 넘습니다`);
        }
        const publicKeys = [];
        for (let i = 0; i < n; i++) {
          publicKeys.unshift(pop());
        }
        const m = decodeNum(pop());
        if (m < 1 || m > n) {
          throw Error(`필요한 서명 수가 1..${n} 가 아닙니다: ${m}`);
        }
        const signatures = [];
        for (let i = 0; i < m; i++) {
          signatures.unshift(pop());
        }

        let matched = 0;
        let keyAt = 0;
        for (const signature of signatures) {
          let found = false;
          while (keyAt < publicKeys.length) {
            const publicKey = publicKeys[keyAt++];
            if (Keys.verify(publicKey.toString("hex"), ctx.txId, signature.toString("hex"))) {
              found = true;
              break;
            }
          }
          if (!found) {
            break;
          }
          matched++;
        }
        const ok = matched === m;
        if (op.code === OP.CHECKMULTISIGVERIFY) {
          if (!ok) {
            throw Error("OP_CHECKMULTISIGVERIFY 실패");
          }
        } else {
          push(ok ? Buffer.from([1]) : Buffer.alloc(0));
        }
        break;
      }
      case OP.CHECKLOCKTIMEVERIFY: {
        /*
         * "이 시각(또는 높이) 전에는 쓸 수 없다."
         *
         * 스크립트는 자기가 담길 블록을 알 수 없으므로 직접 시각을 볼 수
         * 없다. 대신 트랜잭션의 lockTime 이 이 값 이상인지 본다. lockTime 은
         * "이 높이/시각이 되어야 블록에 담길 수 있다"는 뜻이므로(3.5절),
         * 둘을 합치면 조건이 성립한다.
         *
         * 스택 값은 버리지 않는다 — 비트코인과 같이 뒤에 OP_DROP 이 온다.
         */
        if (stack.length === 0) {
          throw Error("스택이 비었습니다");
        }
        const required = decodeNum(stack[stack.length - 1], 5);
        if (required < 0) {
          throw Error("CLTV 값이 음수입니다");
        }
        if (typeof ctx.lockTime !== "number") {
          throw Error("트랜잭션에 lockTime 이 없습니다");
        }
        // 높이와 시각을 섞으면 안 된다
        if ((required < LOCKTIME_THRESHOLD) !== (ctx.lockTime < LOCKTIME_THRESHOLD)) {
          throw Error("CLTV 와 lockTime 의 단위(높이/시각)가 다릅니다");
        }
        if (required > ctx.lockTime) {
          throw Error(`CLTV: lockTime 이 ${required} 이상이어야 합니다 (${ctx.lockTime})`);
        }
        break;
      }
      default:
        throw Error(`실행할 수 없는 연산자 0x${op.code.toString(16)}`);
    }
  }

  if (branches.length !== 0) {
    throw Error("OP_IF 가 닫히지 않았습니다");
  }
  if (stack.length === 0) {
    throw Error("스택이 비어 끝났습니다");
  }
  if (stack.length > 1) {
    // 남은 값이 있으면 거부한다. 그냥 두면 같은 조건에 여러 해제가 생긴다.
    throw Error(`스택에 값이 ${stack.length}개 남았습니다`);
  }
  return isTruthy(stack[stack.length - 1]);
};

/* ------------------------------------------- 표준 스크립트 */

const publicKeyHash = pubHex => hash160(Buffer.from(pubHex, "hex"));

// <m> <pub...> <n> OP_CHECKMULTISIG — m-of-n 다중서명
const multisig = (m, publicKeys) => {
  if (!Number.isInteger(m) || !Array.isArray(publicKeys)) {
    throw Error("m 과 공개키 목록이 필요합니다");
  }
  if (publicKeys.length < 1 || publicKeys.length > MAX_SIGOPS) {
    throw Error(`공개키는 1..${MAX_SIGOPS}개여야 합니다`);
  }
  if (m < 1 || m > publicKeys.length) {
    throw Error(`m 은 1..${publicKeys.length} 여야 합니다`);
  }
  for (const publicKey of publicKeys) {
    if (!Keys.isValidPublicKey(publicKey)) {
      throw Error(`공개키가 아닙니다: ${publicKey}`);
    }
  }
  return compile([
    { num: m },
    ...publicKeys.map(publicKey => ({ data: publicKey })),
    { num: publicKeys.length },
    OP.CHECKMULTISIG
  ]);
};

// <lockTime> OP_CHECKLOCKTIMEVERIFY OP_DROP OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG
const timeLocked = (lockTime, publicKey) => {
  if (!Number.isInteger(lockTime) || lockTime < 1) {
    throw Error("lockTime 은 양의 정수여야 합니다");
  }
  if (!Keys.isValidPublicKey(publicKey)) {
    throw Error("공개키가 아닙니다");
  }
  return compile([
    { num: lockTime },
    OP.CHECKLOCKTIMEVERIFY,
    OP.DROP,
    OP.DUP,
    OP.HASH160,
    { data: publicKeyHash(publicKey) },
    OP.EQUALVERIFY,
    OP.CHECKSIG
  ]);
};

/*
 * 해시 타임락(HTLC) — 원자적 교환과 결제 채널의 바탕.
 *
 *   받는 쪽: 비밀값(preimage)을 알면 언제든 가져간다
 *   보낸 쪽: lockTime 이 지나면 돌려받는다
 *
 * 해제: 받는 쪽 [sig, pub, preimage, 1] / 보낸 쪽 [sig, pub, ""]
 */
const hashTimeLocked = ({ hash, receiverPublicKey, senderPublicKey, lockTime }) => {
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw Error("hash 는 sha256 32바이트 hex 여야 합니다");
  }
  if (!Keys.isValidPublicKey(receiverPublicKey) || !Keys.isValidPublicKey(senderPublicKey)) {
    throw Error("공개키가 아닙니다");
  }
  if (!Number.isInteger(lockTime) || lockTime < 1) {
    throw Error("lockTime 은 양의 정수여야 합니다");
  }
  return compile([
    OP.IF,
    OP.SHA256,
    { data: hash },
    OP.EQUALVERIFY,
    OP.DUP,
    OP.HASH160,
    { data: publicKeyHash(receiverPublicKey) },
    OP.ELSE,
    { num: lockTime },
    OP.CHECKLOCKTIMEVERIFY,
    OP.DROP,
    OP.DUP,
    OP.HASH160,
    { data: publicKeyHash(senderPublicKey) },
    OP.ENDIF,
    OP.EQUALVERIFY,
    OP.CHECKSIG
  ]);
};

// OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG — 주소 하나짜리(P2SH 안에서)
const payToPublicKeyHash = publicKey =>
  compile([
    OP.DUP,
    OP.HASH160,
    { data: publicKeyHash(publicKey) },
    OP.EQUALVERIFY,
    OP.CHECKSIG
  ]);

/*
 * 스크립트가 어떤 표준 꼴인지 알아본다. 익스플로러와 지갑이 "2-of-3
 * 다중서명" 처럼 보여 주는 데 쓴다. 못 알아보면 { type: "custom" }.
 */
const describe = scriptHex => {
  let ops;
  try {
    ops = parse(scriptHex);
  } catch (e) {
    return { type: "invalid", reason: e.message };
  }
  const codes = ops.map(op => op.code);
  const last = ops[ops.length - 1];

  if (last && last.code === OP.CHECKMULTISIG && ops.length >= 4) {
    const m = ops[0].data && ops[0].data.length <= 4 ? safeNum(ops[0].data) : null;
    const n = ops[ops.length - 2].data ? safeNum(ops[ops.length - 2].data) : null;
    if (m !== null && n !== null && ops.length === n + 3) {
      return {
        type: "multisig",
        m,
        n,
        publicKeys: ops.slice(1, 1 + n).map(op => op.data.toString("hex"))
      };
    }
  }
  if (codes.includes(OP.CHECKLOCKTIMEVERIFY) && codes.includes(OP.IF)) {
    return { type: "htlc", lockTime: cltvValue(ops) };
  }
  if (codes.includes(OP.CHECKLOCKTIMEVERIFY)) {
    return { type: "timelock", lockTime: cltvValue(ops) };
  }
  if (
    codes.length === 5 &&
    codes[0] === OP.DUP &&
    codes[1] === OP.HASH160 &&
    codes[3] === OP.EQUALVERIFY &&
    codes[4] === OP.CHECKSIG
  ) {
    return { type: "p2pkh", publicKeyHash: ops[2].data.toString("hex") };
  }
  return { type: "custom" };
};

const safeNum = buf => {
  try {
    return decodeNum(buf);
  } catch (e) {
    return null;
  }
};

const cltvValue = ops => {
  const at = ops.findIndex(op => op.code === OP.CHECKLOCKTIMEVERIFY);
  return at > 0 && ops[at - 1].data ? safeNum5(ops[at - 1].data) : null;
};

const safeNum5 = buf => {
  try {
    return decodeNum(buf, 5);
  } catch (e) {
    return null;
  }
};

module.exports = {
  OP,
  OP_NAME,
  LOCKTIME_THRESHOLD,
  MAX_SCRIPT_BYTES,
  MAX_PUSH_BYTES,
  MAX_STACK,
  MAX_OPS,
  MAX_SIGOPS,
  encodeNum,
  decodeNum,
  isTruthy,
  pushData,
  pushNum,
  compile,
  parse,
  toAsm,
  run,
  multisig,
  timeLocked,
  hashTimeLocked,
  payToPublicKeyHash,
  publicKeyHash,
  describe
};
