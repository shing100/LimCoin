/**
 * 채굴 워커.
 *
 * 블록마다 새로 띄우지 않고 살려 둔 채 일감을 받는다. 워커를 띄우는 데
 * 수십 ms 가 드는데, 난이도가 낮으면 그 값이 채굴 시간보다 커진다.
 * (4코어에서 재 보니 워커 4개가 2개보다 느렸다 — 띄우는 값이 이겼다)
 *
 * 여러 워커가 같은 헤더를 돌 때 겹치지 않도록 nonce 공간을 나눈다.
 * 워커 k 가 from=k, stride=N 으로 돌면 각자 다른 nonce 만 본다.
 *
 * 중단 요청을 받으려면 루프를 조각내야 한다 — 워커 안에서도 메시지를
 * 받으려면 이벤트 루프가 돌아야 하기 때문이다.
 */
const { parentPort } = require("worker_threads");
const { findNonce } = require("./pow");

const CHUNK = 50000;

// 지금 맡은 일감. null 이면 노는 중이다.
let current = null;

const step = () => {
  const job = current;
  if (job === null) {
    return;
  }

  const found = findNonce(job.header, job.nonce, CHUNK, job.stride);

  // 이 조각을 도는 사이에 중단되었거나 새 일감이 왔을 수 있다
  if (current !== job) {
    return;
  }

  if (found !== null) {
    current = null;
    parentPort.postMessage({ type: "found", jobId: job.jobId, ...found });
    return;
  }

  job.nonce += CHUNK * job.stride;
  setImmediate(step);
};

parentPort.on("message", message => {
  if (message.type === "mine") {
    current = {
      jobId: message.jobId,
      header: message.header,
      from: message.from,
      stride: message.stride,
      nonce: message.from
    };
    setImmediate(step);
  } else if (message.type === "stop") {
    current = null;
  }
});
