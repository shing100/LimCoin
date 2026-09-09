/**
 * 린트 설정.
 *
 * 스타일을 통일하려는 것이 아니다(그건 사람이 읽으며 맞춘다). 여기서 잡으려는
 * 것은 **돌려 봐야만 드러나는 실수**다 — 오타로 만든 전역 변수, 쓰지 않는
 * 변수, 잡아 놓고 버린 예외, `==` 로 인한 형 변환 같은 것.
 *
 * 합의 코드에서 이런 실수 하나는 곧 체인 분기다. 테스트가 지나가도 남아 있을
 * 수 있으므로 기계가 한 번 더 본다.
 */
"use strict";

const common = {
  // 오타로 만든 전역과 선언 없는 변수
  "no-undef": "error",
  "no-implicit-globals": "error",
  "no-redeclare": "error",
  "no-shadow-restricted-names": "error",

  // 죽은 코드 — 지우다 만 흔적이거나 쓰려다 만 것
  "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^unused" }],
  "no-unreachable": "error",
  "no-constant-condition": ["error", { checkLoops: false }],

  // 조용히 틀리는 것들
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-fallthrough": "error",
  "no-self-compare": "error",
  "no-unsafe-negation": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-duplicate-case": "error",
  "no-sparse-arrays": "error",
  "no-prototype-builtins": "error",
  "no-loss-of-precision": "error",
  "require-atomic-updates": "error",
  "no-async-promise-executor": "error",
  "no-promise-executor-return": "error",
  "no-return-assign": "error",
  "no-compare-neg-zero": "error",

  // 예외를 잡아 놓고 아무것도 안 하는 것 — 실패가 조용히 사라진다
  "no-empty": ["error", { allowEmptyCatch: false }],

  // 실수로 남긴 디버깅
  "no-debugger": "error",
  "no-console": "off", // 노드 로그는 console 로 낸다

  // 금액·해시를 다루므로
  "use-isnan": "error",
  "valid-typeof": "error"
};

const nodeGlobals = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  URL: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  structuredClone: "readonly"
};

module.exports = [
  {
    ignores: ["node_modules/**", "data/**", "LimCoin/**", "coverage/**"]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: nodeGlobals
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    },
    rules: common
  }
];
