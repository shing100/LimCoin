/**
 * BIP39 니모닉.
 *
 * HD 지갑(BIP32)은 씨앗 하나만 있으면 모든 주소를 되살릴 수 있다. 그런데
 * 그 씨앗이 64자짜리 16진수라 사람이 옮겨 적기 어렵다. 한 글자만 틀려도
 * 지갑을 잃는다.
 *
 * BIP39 는 그 씨앗을 단어 목록으로 바꾼다.
 *
 *   엔트로피 -> 체크섬 붙임 -> 11비트씩 쪼개 단어로 -> 니모닉
 *   니모닉 -> PBKDF2-HMAC-SHA512 (2048회) -> 64바이트 씨앗
 *
 * 체크섬이 있어서 한 단어라도 잘못 적으면 대개 걸린다. 단어 목록은 앞
 * 네 글자만으로 서로 구별되도록 골라져 있어 뒷부분을 틀려도 알아볼 수 있다.
 *
 * 구현에 필요한 것은 Node 내장 crypto 의 sha256 과 pbkdf2 뿐이다.
 */
const crypto = require("crypto");
const WORDLIST = require("./bip39-wordlist");

const BITS_PER_WORD = 11; // 2048 = 2^11
const PBKDF2_ROUNDS = 2048;
const SEED_BYTES = 64;

// 엔트로피 128~256비트, 32비트 단위. 각각 12~24단어가 된다.
const DEFAULT_ENTROPY_BITS = 256; // 24단어

const toBinary = buffer =>
  Array.from(buffer)
    .map(byte => byte.toString(2).padStart(8, "0"))
    .join("");

// 체크섬은 SHA256(엔트로피) 의 앞 (엔트로피비트/32) 비트다.
const checksumBits = entropy => {
  const digest = crypto.createHash("sha256").update(entropy).digest();
  return toBinary(digest).slice(0, (entropy.length * 8) / 32);
};

const isValidEntropyLength = bytes =>
  bytes >= 16 && bytes <= 32 && bytes % 4 === 0;

/**
 * 엔트로피 -> 니모닉.
 */
const entropyToMnemonic = entropy => {
  if (!Buffer.isBuffer(entropy) || !isValidEntropyLength(entropy.length)) {
    throw Error("엔트로피는 16~32바이트이고 4바이트 배수여야 합니다");
  }
  const bits = toBinary(entropy) + checksumBits(entropy);
  const words = [];
  for (let i = 0; i < bits.length; i += BITS_PER_WORD) {
    words.push(WORDLIST[parseInt(bits.slice(i, i + BITS_PER_WORD), 2)]);
  }
  return words.join(" ");
};

const generateMnemonic = (entropyBits = DEFAULT_ENTROPY_BITS) => {
  if (entropyBits % 32 !== 0 || entropyBits < 128 || entropyBits > 256) {
    throw Error("엔트로피 비트는 128~256 사이의 32의 배수여야 합니다");
  }
  return entropyToMnemonic(crypto.randomBytes(entropyBits / 8));
};

// 공백 정리 + NFKD 정규화. BIP39 는 니모닉을 NFKD 로 다루도록 정한다.
const normalize = mnemonic =>
  mnemonic
    .normalize("NFKD")
    .trim()
    .split(/\s+/)
    .join(" ");

/**
 * 니모닉 -> 엔트로피. 단어와 체크섬이 맞지 않으면 던진다.
 */
const mnemonicToEntropy = mnemonic => {
  const words = normalize(mnemonic).split(" ");

  if (words.length % 3 !== 0 || words.length < 12 || words.length > 24) {
    throw Error("니모닉은 12, 15, 18, 21, 24 단어여야 합니다");
  }

  let bits = "";
  for (const word of words) {
    const index = WORDLIST.indexOf(word);
    if (index === -1) {
      throw Error(`단어 목록에 없는 단어입니다: ${word}`);
    }
    bits += index.toString(2).padStart(BITS_PER_WORD, "0");
  }

  const entropyLength = (bits.length * 32) / 33 / 8;
  const entropy = Buffer.from(
    bits
      .slice(0, entropyLength * 8)
      .match(/.{8}/g)
      .map(byte => parseInt(byte, 2))
  );

  if (checksumBits(entropy) !== bits.slice(entropyLength * 8)) {
    throw Error("니모닉의 체크섬이 맞지 않습니다. 단어를 다시 확인하세요.");
  }
  return entropy;
};

const validateMnemonic = mnemonic => {
  try {
    mnemonicToEntropy(mnemonic);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * 니모닉 -> 씨앗(64바이트 16진수).
 *
 * 암호(passphrase)를 주면 같은 니모닉으로도 다른 지갑이 된다. BIP39 는
 * 이것을 "25번째 단어"라고 부른다. 잊으면 되살릴 방법이 없다.
 *
 * 체크섬 검사를 거치지 않는 것이 명세다 — 어떤 문자열이든 씨앗이 된다.
 * 그래서 부르는 쪽에서 validateMnemonic 을 먼저 확인해야 한다.
 */
const mnemonicToSeed = (mnemonic, passphrase = "") =>
  crypto
    .pbkdf2Sync(
      normalize(mnemonic),
      ("mnemonic" + passphrase).normalize("NFKD"),
      PBKDF2_ROUNDS,
      SEED_BYTES,
      "sha512"
    )
    .toString("hex");

module.exports = {
  generateMnemonic,
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
  validateMnemonic,
  WORDLIST
};
