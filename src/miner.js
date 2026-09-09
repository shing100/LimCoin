/**
 * 자동 채굴 루프.
 *
 * 지금까지는 `POST /blocks` 를 사람이 쳐야만 블록이 생겼다. 그래서 난이도
 * 조절 로직이 실제로는 "사람이 curl 을 치는 속도"를 재고 있었다. 블록이
 * 꾸준히 나와야 난이도 조절이 의미를 갖는다.
 *
 * 노드를 띄울 때 LIMCOIN_MINE=1 이거나 POST /mining 으로 켤 수 있다.
 */
const Blockchain = require("./blockchain");
const Target = require("./target");

const { createNewBlock } = Blockchain;

let running = false;
let loopPromise = null;
let mined = 0;
let lastError = null;

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const loop = async () => {
  while (running) {
    try {
      const block = await createNewBlock();
      mined++;
      lastError = null;
      console.log(`채굴: 블록 #${block.index} (난이도 ${Target.difficultyOf(block.bits).toFixed(0)}, tx ${block.data.length}건)`);
    } catch (e) {
      // 다른 노드가 먼저 블록을 올렸거나 잔액이 모자란 경우.
      // 루프를 세우지 않고 다음 회차로 넘어간다.
      lastError = e.message;
      await sleep(1000);
    }
    // 다음 블록 사이에 잠깐 쉰다. 이게 없으면 CPU 를 100% 쓴다.
    await sleep(200);
  }
};

const start = () => {
  if (running) {
    return false;
  }
  running = true;
  loopPromise = loop();
  console.log("자동 채굴을 시작합니다");
  return true;
};

const stop = async () => {
  if (!running) {
    return false;
  }
  running = false;
  // 기다리는 사이에 다시 start() 가 불릴 수 있다. 그때 새로 생긴 루프를
  // 지우면 다음 stop() 이 아무것도 기다리지 않고 돌아온다.
  const stopping = loopPromise;
  await stopping; // 진행 중인 블록을 마저 끝낸다
  if (loopPromise === stopping) {
    loopPromise = null;
  }
  console.log("자동 채굴을 멈췄습니다");
  return true;
};

const getStatus = () => ({ running, mined, lastError });

module.exports = { start, stop, getStatus };
