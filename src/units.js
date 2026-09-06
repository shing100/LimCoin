/**
 * 화폐 단위.
 *
 * 원래 LimCoin 은 금액을 그냥 정수로 다뤘다(1 = 1 LIM). 그러면
 *
 *  - 최소 수수료가 1 LIM 인데 블록 보조금이 10 LIM 이라 수수료가 보상의 10% 다.
 *    수수료 시장이 성립하지 않는다.
 *  - 반감기를 넣어도 10 -> 5 -> 2 -> 1 -> 0 으로 네 번 만에 0 이 된다.
 *
 * 비트코인이 사토시를 두는 이유가 이것이다. 프로토콜과 API 는 전부 이 최소
 * 단위(lm)로 주고받고, 사람에게 보여 줄 때만 LIM 으로 환산한다.
 * 부동소수점을 쓰지 않으므로 반올림 오차가 생기지 않는다.
 */
const DECIMALS = 8;
const COIN = 100000000; // 1 LIM = 100,000,000 lm

// "1.5" 같은 사람이 쓴 값을 최소 단위 정수로. 부동소수점을 거치지 않는다.
const parseLim = value => {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw Error(`금액 형식이 올바르지 않습니다: ${value}`);
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > DECIMALS) {
    throw Error(`소수점 아래는 ${DECIMALS}자리까지만 쓸 수 있습니다`);
  }
  const padded = (fraction + "0".repeat(DECIMALS)).slice(0, DECIMALS);
  return Number(whole) * COIN + Number(padded);
};

// 최소 단위 정수를 사람이 읽는 문자열로. 뒤따르는 0 은 떼어 낸다.
const formatLim = amount => {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / COIN);
  const fraction = String(abs % COIN).padStart(DECIMALS, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : String(whole);
  return negative ? `-${text}` : text;
};

module.exports = { COIN, DECIMALS, parseLim, formatLim };
