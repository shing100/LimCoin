/**
 * 채굴 워커.
 *
 * 메인 스레드에서 헤더를 받아 nonce 를 찾고 결과를 돌려준다.
 *
 * 예전에는 메인 스레드에서 돌리되 일정 해시마다 이벤트 루프에 양보했다.
 * 그러면 HTTP 응답이 막히지는 않지만 채굴과 서버가 한 코어를 나눠 쓴다.
 * 워커로 빼면 채굴이 다른 코어에서 돌고 메인 스레드는 손대지 않는다.
 *
 * 중단 요청을 받으려면 루프를 조각내야 한다 — 워커 안에서도 메시지를
 * 받으려면 이벤트 루프가 돌아야 하기 때문이다.
 */
const { parentPort, workerData } = require("worker_threads");
const { findNonce } = require("./pow");

const CHUNK = 50000;

let stopped = false;

parentPort.on("message", message => {
  if (message === "stop") {
    stopped = true;
  }
});

const run = () => {
  let nonce = 0;
  const step = () => {
    if (stopped) {
      parentPort.postMessage({ type: "stopped" });
      return;
    }
    const found = findNonce(workerData, nonce, CHUNK);
    if (found !== null) {
      parentPort.postMessage({ type: "found", ...found });
      return;
    }
    nonce += CHUNK;
    // setImmediate 로 넘겨야 그 사이에 stop 메시지를 받을 수 있다
    setImmediate(step);
  };
  step();
};

run();
