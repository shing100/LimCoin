/**
 * 망(network) 파라미터.
 *
 * 메인넷과 테스트넷은 제네시스, 주소 버전 바이트, P2P 매직이 다르다.
 * 테스트넷 코인은 값어치가 없어야 하므로 두 망은 절대 섞이지 않아야 한다 —
 * 테스트넷 주소로 메인넷 코인을 보낼 수 없고, 다른 망의 피어는 붙자마자
 * 끊는다.
 *
 *   LIMCOIN_NETWORK=testnet node src/server.js
 *
 * 기본은 mainnet. 합의 규칙(보조금, 반감기, 성숙도, 난이도 조정)은 두 망이
 * 같다 — 테스트넷은 "값어치 없는 메인넷"이어야 의미가 있다.
 */
const NETWORKS = {
  mainnet: {
    name: "mainnet",
    // 0x30 -> 주소가 'L' 로 시작한다
    addressVersion: 0x30,
    genesisFile: "./genesis.json",
    magic: "limcoin/main/1",
    defaultDataSubdir: "mainnet",
    // 시간을 앞당겨 적어 난이도를 피하는 길을 메인넷에는 두지 않는다
    allowMinDifficultyBlocks: false,
    // 뜰 때 붙어 볼 피어. 아직 없다 — 공개 시드 노드가 생기면 여기 적는다.
    seeds: []
  },
  testnet: {
    name: "testnet",
    // 0x6f -> 'm' 또는 'n' (비트코인 테스트넷과 같다)
    addressVersion: 0x6f,
    genesisFile: "./genesis.testnet.json",
    magic: "limcoin/test/1",
    defaultDataSubdir: "testnet",
    // 200초 넘게 블록이 없으면 최소 난이도 블록을 받아 준다 (비트코인 테스트넷의 20분 규칙)
    allowMinDifficultyBlocks: true,
    seeds: []
  }
};

const selected = process.env.LIMCOIN_NETWORK || "mainnet";
if (!NETWORKS[selected]) {
  throw Error(`LIMCOIN_NETWORK 는 ${Object.keys(NETWORKS).join(" 또는 ")} 여야 합니다: ${selected}`);
}

const current = () => NETWORKS[selected];

module.exports = { NETWORKS, current };
