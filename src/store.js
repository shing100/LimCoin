/**
 * 체인 저장소.
 *
 * 지금까지 블록체인은 통째로 메모리에만 있었다(`let blockchain = [...]`).
 * 노드를 재시작하면 제네시스부터 다시 시작했고, 네트워크 전체가 한 번
 * 내려가면 모든 기록이 사라졌다. 블록체인으로서는 결함에 가깝다.
 *
 * 블록은 본래 append-only 이므로 한 줄에 한 블록씩 쌓는 것으로 충분하다.
 * (JSON Lines) 데이터베이스를 끌어오지 않아 의존성이 늘지 않고, 파일을
 * 그대로 열어 볼 수 있어 배우기에도 낫다.
 *
 * 체인 재구성(reorg)은 append 로 표현할 수 없으므로 그때만 파일을 새로
 * 쓴다. 이때 임시 파일에 쓰고 rename 하므로, 도중에 죽어도 반쯤 쓰인
 * 파일이 남지 않는다.
 */
const fs = require("fs"),
  path = require("path"),
  os = require("os");

const BLOCKS_FILE = "blocks.jsonl";

// open() 을 부르기 전에는 아무것도 저장하지 않는다.
// 테스트는 open() 을 부르지 않으므로 디스크를 건드리지 않는다.
let dir = null;

const blocksPath = () => path.join(dir, BLOCKS_FILE);

// 노드마다 다른 디렉터리를 써야 한 대에서 여러 노드를 띄울 수 있다.
const defaultDir = () =>
  process.env.LIMCOIN_DATA_DIR ||
  path.join(__dirname, "..", "data", String(process.env.HTTP_PORT || 3000));

const open = (dataDir = defaultDir()) => {
  dir = dataDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const close = () => {
  dir = null;
};

const isOpen = () => dir !== null;

/**
 * 저장된 블록을 읽는다.
 *
 * 마지막 줄은 append 도중 죽었을 수 있어 깨져 있을 수 있다. 그런 줄은
 * 버리고 거기까지만 돌려준다 — 어차피 P2P 로 다시 받아 오면 된다.
 */
const loadBlocks = () => {
  if (!isOpen() || !fs.existsSync(blocksPath())) {
    return [];
  }
  const lines = fs
    .readFileSync(blocksPath(), "utf8")
    .split("\n")
    .filter(line => line.trim() !== "");

  const blocks = [];
  for (const line of lines) {
    try {
      blocks.push(JSON.parse(line));
    } catch (e) {
      console.log(
        `저장된 체인의 ${blocks.length + 1}번째 줄이 깨져 있습니다. 여기까지만 복원합니다.`
      );
      break;
    }
  }
  return blocks;
};

const appendBlock = block => {
  if (!isOpen()) {
    return;
  }
  fs.appendFileSync(blocksPath(), JSON.stringify(block) + os.EOL);
};

// 체인이 통째로 교체될 때(reorg). 임시 파일에 쓰고 rename 해서
// 도중에 죽어도 반쯤 쓰인 파일이 남지 않게 한다.
const writeBlocks = blocks => {
  if (!isOpen()) {
    return;
  }
  const tmp = blocksPath() + ".tmp";
  fs.writeFileSync(tmp, blocks.map(b => JSON.stringify(b)).join(os.EOL) + os.EOL);
  fs.renameSync(tmp, blocksPath());
};

module.exports = { open, close, isOpen, loadBlocks, appendBlock, writeBlocks, defaultDir };
