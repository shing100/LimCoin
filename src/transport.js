/**
 * P2P 전송 암호화.
 *
 * 지금까지 피어 사이의 메시지는 평문 JSON 이었다. 같은 망에 있는 누구나
 * 무엇이 오가는지 볼 수 있었고 — 어느 노드가 어떤 트랜잭션을 처음 흘렸는지가
 * 곧 "그 트랜잭션을 만든 사람"이다 — 중간에서 메시지를 갈아 끼울 수도 있었다.
 *
 * 비트코인의 BIP324 와 같은 얼개다.
 *
 *   1. 붙자마자 서로 임시 X25519 공개키를 보낸다. 자기 신원키(Ed25519)로
 *      그 임시 공개키에 서명해 함께 보낸다.
 *   2. 임시 키끼리 ECDH 해서 나온 비밀을 HKDF 로 늘려 방향마다 다른 키를
 *      뽑는다. 임시 키는 연결마다 새로 만들므로, 나중에 신원키가 새더라도
 *      지난 대화는 풀리지 않는다(전방 비밀성).
 *   3. 그 뒤 모든 메시지는 ChaCha20-Poly1305 로 싼다. nonce 는 방향마다
 *      1씩 오르는 번호라 같은 값이 두 번 쓰이지 않는다.
 *
 * 신원키는 데이터 디렉터리의 `node_key` 에 남는다. 그 공개키가 노드 id 이고,
 * 피어 주소에 `#<id>` 로 붙여 두면 그 노드가 맞는지 확인한다(고정).
 * 고정하지 않으면 엿듣기는 막지만 중간자는 막지 못한다 — 기회주의적 TLS 와
 * 같은 한계다.
 *
 * 한 왕복이라 남의 HANDSHAKE 를 그대로 베껴 보낼 수는 있다. 받는 쪽은 그
 * 신원으로 받아들이지만, 베낀 쪽에는 상대의 임시 개인키가 없어 프레임을
 * 하나도 만들거나 읽지 못한다. 남는 것은 곧 끊기는 빈 연결(방해)뿐이다.
 * 막으려면 왕복을 하나 더 써서 상대의 임시 키까지 서명해야 한다.
 *
 * LIMCOIN_ENCRYPT
 *   optional  (기본) 상대가 받아 주면 암호화한다. 못 하면 평문으로 간다.
 *   required  암호화하지 못하는 피어는 끊는다.
 *   off       암호화하지 않는다.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROTOCOL = "limcoin/transport/1";
const HANDSHAKE = "HANDSHAKE";
const ENCRYPTED = "ENC";
// required 모드에서 이만큼 안에 핸드셰이크가 오지 않으면 끊는다
const HANDSHAKE_TIMEOUT = 10000;
/*
 * optional 모드에서 이만큼 기다려 보고, 상대가 핸드셰이크를 보내지 않으면
 * 평문으로 내려간다. 암호화를 모르는 상대(익스플로러 등)도 붙을 수 있어야
 * 하지만, 그 사이 오갈 메시지를 평문으로 흘리고 싶지도 않다.
 */
const PLAINTEXT_FALLBACK = 1500;

const mode = () => {
  const value = process.env.LIMCOIN_ENCRYPT || "optional";
  return ["optional", "required", "off"].includes(value) ? value : "optional";
};

/* ------------------------------------------- 키 다루기 */

const rawOf = key => Buffer.from(key.export({ format: "jwk" }).x, "base64url");

const publicFrom = (crv, raw) =>
  crypto.createPublicKey({
    key: { kty: "OKP", crv, x: Buffer.from(raw, "hex").toString("base64url") },
    format: "jwk"
  });

const isHex32 = value => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

/* ------------------------------------------- 신원키 */

let identity = null;

/*
 * 신원키를 읽거나 만든다. 데이터 디렉터리가 없으면(테스트) 메모리에만 둔다 —
 * 그러면 뜰 때마다 id 가 바뀌지만 통신은 된다.
 */
const loadIdentity = dir => {
  if (dir) {
    const file = path.join(dir, "node_key");
    try {
      if (fs.existsSync(file)) {
        const privateKey = crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
        identity = { privateKey, publicKey: crypto.createPublicKey(privateKey) };
        return nodeId();
      }
    } catch (e) {
      console.log(`node_key 를 읽을 수 없어 새로 만듭니다: ${e.message}`);
    }
  }
  const pair = crypto.generateKeyPairSync("ed25519");
  identity = { privateKey: pair.privateKey, publicKey: pair.publicKey };
  if (dir) {
    const file = path.join(dir, "node_key");
    // 신원키가 새면 남이 우리 노드를 사칭할 수 있다. 주인만 읽게 한다.
    fs.writeFileSync(file, identity.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600
    });
    try {
      fs.chmodSync(file, 0o600);
    } catch (e) {
      // 권한 개념이 없는 파일 시스템이면 넘어간다
    }
  }
  return nodeId();
};

const nodeId = () => {
  if (identity === null) {
    loadIdentity(null);
  }
  return rawOf(identity.publicKey).toString("hex");
};

/* ------------------------------------------- 핸드셰이크 */

// 서명 대상: 프로토콜 이름 + 망 + 내 임시 공개키. 다른 망이나 다른 연결에
// 쓰던 서명을 그대로 가져다 쓸 수 없게 묶는다.
const transcript = (network, ephemeralHex) =>
  Buffer.from(`${PROTOCOL}|${network}|${ephemeralHex}`, "utf8");

const startSession = (ws, network, onFallback) => {
  if (mode() === "off") {
    ws.transport = { state: "plain" };
    return null;
  }
  const pair = crypto.generateKeyPairSync("x25519");
  const ephemeralHex = rawOf(pair.publicKey).toString("hex");
  ws.transport = {
    state: "handshaking",
    ephemeral: pair,
    ephemeralHex,
    queue: [],
    sendCounter: 0,
    recvCounter: 0,
    peerId: null,
    // 상대가 암호문을 보내기 시작했는가 (그 뒤로는 평문을 받지 않는다)
    sawEncrypted: false
  };
  if (mode() === "required") {
    ws.transport.timer = setTimeout(() => {
      if (ws.transport && ws.transport.state !== "encrypted") {
        console.log("암호화 핸드셰이크가 오지 않아 끊습니다 (LIMCOIN_ENCRYPT=required)");
        try {
          ws.close();
        } catch (e) {
          // 이미 닫혔다
        }
      }
    }, HANDSHAKE_TIMEOUT);
  } else {
    ws.transport.timer = setTimeout(() => {
      const session = ws.transport;
      if (!session || session.state !== "handshaking") {
        return;
      }
      session.state = "plain";
      const pending = session.queue;
      session.queue = [];
      if (typeof onFallback === "function" && pending.length > 0) {
        onFallback(pending);
      }
    }, PLAINTEXT_FALLBACK);
  }
  ws.transport.timer.unref();
  return {
    type: HANDSHAKE,
    data: {
      v: 1,
      network,
      id: nodeId(),
      eph: ephemeralHex,
      sig: crypto
        .sign(null, transcript(network, ephemeralHex), identity.privateKey)
        .toString("hex")
    }
  };
};

/*
 * 상대의 핸드셰이크를 받아 키를 뽑는다.
 * 돌려주는 값이 false 면 받아들일 수 없는 상대다(부르는 쪽이 끊는다).
 */
const acceptHandshake = (ws, data, network, expectedId) => {
  const session = ws.transport;
  if (!session || session.state !== "handshaking") {
    return false;
  }
  if (
    data === null ||
    typeof data !== "object" ||
    data.v !== 1 ||
    data.network !== network ||
    !isHex32(data.id) ||
    !isHex32(data.eph) ||
    typeof data.sig !== "string"
  ) {
    return false;
  }
  // 이 임시 키가 정말 저 신원키의 것인지
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      transcript(network, data.eph),
      publicFrom("Ed25519", data.id),
      Buffer.from(data.sig, "hex")
    );
  } catch (e) {
    return false;
  }
  if (!ok) {
    console.log("핸드셰이크 서명이 맞지 않습니다");
    return false;
  }
  if (expectedId && expectedId.toLowerCase() !== data.id.toLowerCase()) {
    console.log(`피어 신원이 고정한 값과 다릅니다 (${data.id})`);
    return "pinned";
  }
  if (data.eph === session.ephemeralHex) {
    // 우리 임시 키를 그대로 되돌려 보낸 것 — 자기 자신이거나 반사 공격이다
    return false;
  }

  const shared = crypto.diffieHellman({
    privateKey: session.ephemeral.privateKey,
    publicKey: publicFrom("X25519", data.eph)
  });
  /*
   * 두 임시 공개키를 순서대로 이어 소금으로 쓴다. 양쪽이 같은 값을 얻어야
   * 하므로 사전순으로 정렬한다. 방향마다 다른 키를 써야 nonce 가 겹치지
   * 않으므로 64바이트를 뽑아 반씩 나눈다.
   */
  const [low, high] = [session.ephemeralHex, data.eph].sort();
  const salt = crypto.createHash("sha256").update(`${low}${high}`).digest();
  const material = Buffer.from(
    crypto.hkdfSync("sha256", shared, salt, Buffer.from(`${PROTOCOL}|${network}`), 64)
  );
  const keyLow = material.subarray(0, 32);
  const keyHigh = material.subarray(32, 64);
  const weAreLow = session.ephemeralHex === low;

  session.sendKey = weAreLow ? keyLow : keyHigh;
  session.recvKey = weAreLow ? keyHigh : keyLow;
  session.peerId = data.id;
  session.state = "encrypted";
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  return true;
};

/* ------------------------------------------- 프레임 */

const nonceOf = counter => {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(0, 0);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
};

const seal = (session, message) => {
  const cipher = crypto.createCipheriv("chacha20-poly1305", session.sendKey, nonceOf(session.sendCounter), {
    authTagLength: 16
  });
  const body = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final()]);
  const frame = {
    type: ENCRYPTED,
    n: session.sendCounter,
    c: Buffer.concat([body, cipher.getAuthTag()]).toString("hex")
  };
  session.sendCounter += 1;
  return frame;
};

const open = (session, frame) => {
  /*
   * 번호는 정확히 다음 것이어야 한다. WebSocket 은 순서를 지키므로, 어긋나면
   * 누가 끼워 넣었거나 지난 메시지를 다시 보낸 것이다.
   */
  if (frame.n !== session.recvCounter) {
    throw Error(`메시지 번호가 어긋납니다 (${frame.n}, 기다린 값 ${session.recvCounter})`);
  }
  const bytes = Buffer.from(frame.c, "hex");
  if (bytes.length < 17) {
    throw Error("암호문이 너무 짧습니다");
  }
  const decipher = crypto.createDecipheriv(
    "chacha20-poly1305",
    session.recvKey,
    nonceOf(session.recvCounter),
    { authTagLength: 16 }
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(0, bytes.length - 16)),
    decipher.final()
  ]).toString("utf8");
  session.recvCounter += 1;
  return JSON.parse(plain);
};

/* ------------------------------------------- 밖에서 쓰는 것 */

const isEncrypted = ws => Boolean(ws.transport && ws.transport.state === "encrypted");

// 보낼 메시지를 감싼다. 아직 준비되지 않았으면 어떻게 할지 함께 알려 준다.
const wrap = (ws, message) => {
  const session = ws.transport;
  if (!session || session.state === "plain") {
    return { send: message };
  }
  if (session.state === "encrypted") {
    return { send: seal(session, message) };
  }
  /*
   * 아직 핸드셰이크 중이다. 잠깐 미뤄 둔다 — 상대도 노드라면 한 왕복이면
   * 끝나므로 아무것도 평문으로 나가지 않는다. 상대가 암호화를 모르면
   * PLAINTEXT_FALLBACK 뒤에 평문으로 내려가며 밀린 것을 그때 보낸다.
   */
  session.queue.push(message);
  return { send: null };
};

// 핸드셰이크가 끝난 뒤 밀린 메시지
const drainQueue = ws => {
  const session = ws.transport;
  if (!session || !session.queue || session.queue.length === 0) {
    return [];
  }
  const pending = session.queue;
  session.queue = [];
  return pending.map(message => seal(session, message));
};

/*
 * 받은 메시지를 푼다.
 *
 *   { handled: true }            핸드셰이크를 처리했다 (부르는 쪽은 더 볼 것 없음)
 *   { message }                  처리할 메시지
 *   { reject: "이유" }           받아들일 수 없다
 */
const unwrap = (ws, raw, network, expectedId) => {
  if (raw !== null && typeof raw === "object" && raw.type === HANDSHAKE) {
    const accepted = acceptHandshake(ws, raw.data, network, expectedId);
    if (accepted === "pinned") {
      // 고정해 둔 노드가 아니다. 점수를 매길 일이 아니라 끊을 일이다.
      return { reject: "고정한 신원과 다른 피어입니다", fatal: true };
    }
    if (!accepted) {
      return { reject: "핸드셰이크를 받아들일 수 없습니다" };
    }
    return { handled: true, established: true };
  }
  const session = ws.transport;
  if (raw !== null && typeof raw === "object" && raw.type === ENCRYPTED) {
    if (!session || session.state !== "encrypted") {
      return { reject: "핸드셰이크 전에 암호문이 왔습니다" };
    }
    session.sawEncrypted = true;
    try {
      return { message: open(session, raw) };
    } catch (e) {
      return { reject: `암호문을 풀 수 없습니다: ${e.message}` };
    }
  }
  // 평문
  if (mode() === "required") {
    return { reject: "평문 메시지는 받지 않습니다 (LIMCOIN_ENCRYPT=required)" };
  }
  /*
   * 우리가 먼저 핸드셰이크를 끝냈어도, 상대가 그것을 보기 전에 부친 평문이
   * 뒤늦게 도착할 수 있다(붙자마자 오가는 HELLO 같은 것). 그것까지 막으면
   * 정상적인 연결에서 첫 메시지 두어 개가 사라진다.
   *
   * 상대가 암호문을 한 번이라도 보낸 뒤에는 평문을 받지 않는다 — 그때부터의
   * 평문은 중간에서 끼워 넣은 것이다. WebSocket 은 순서를 지키므로 이걸로
   * 갈린다.
   */
  if (session && session.sawEncrypted) {
    return { reject: "암호화된 연결에 평문이 왔습니다" };
  }
  return { message: raw };
};

const peerIdOf = ws => (ws.transport && ws.transport.peerId) || null;

const endSession = ws => {
  if (ws.transport && ws.transport.timer) {
    clearTimeout(ws.transport.timer);
    ws.transport.timer = null;
  }
};

/*
 * 피어 주소에서 고정한 신원을 떼어 낸다.
 *   ws://호스트:포트#<노드 id>
 */
const splitPinned = url => {
  if (typeof url !== "string") {
    return { url, id: null };
  }
  const at = url.indexOf("#");
  if (at === -1) {
    return { url, id: null };
  }
  const id = url.slice(at + 1);
  return { url: url.slice(0, at), id: isHex32(id) ? id : null };
};

module.exports = {
  PROTOCOL,
  HANDSHAKE,
  ENCRYPTED,
  mode,
  loadIdentity,
  nodeId,
  startSession,
  wrap,
  unwrap,
  drainQueue,
  isEncrypted,
  peerIdOf,
  endSession,
  splitPinned
};
