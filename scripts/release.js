/**
 * 릴리스 산출물을 만든다.
 *
 *   node scripts/release.js                 # dist/ 에 tar.gz 와 SHA256SUMS
 *   node scripts/release.js --version 1.1.0 # package.json 대신 이 판번호로
 *
 * 왜. 거래소나 채굴자가 노드를 받아 돌릴 때 "내가 받은 것이 저쪽이 만든 그것"
 * 인지 확인할 방법이 있어야 한다. git clone 으로 충분하다고 여기기 쉽지만,
 * 실제 운영에서는 압축 파일 하나를 내려받아 옮기는 경우가 훨씬 많고 그때
 * 붙잡을 것이 체크섬뿐이다.
 *
 * 담는 것: src, scripts, docs, package.json, yarn.lock, Dockerfile, 라이선스,
 *          README, 합의 벡터.
 * 빼는 것: node_modules, 테스트, 지갑 파일, 체인 데이터, .git.
 *
 * 재현 가능하게 만든다 — 같은 커밋에서 두 번 돌리면 같은 해시가 나와야 한다.
 * 그래서 tar 에 넣는 파일의 시각·소유자·권한을 고정하고 이름순으로 넣는다.
 * (mtime 을 그대로 두면 체크아웃할 때마다 해시가 달라져 아무 소용이 없다.)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const arg = name => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = arg("version") || pkg.version;
const name = `limcoin-${version}`;

// 담을 것. 디렉터리면 통째로, 파일이면 그것만.
const INCLUDE = [
  "src",
  "scripts",
  "docs",
  "package.json",
  "yarn.lock",
  "Dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md"
];

// 담지 않을 것 — 키나 남의 컴퓨터 사정이 섞여 들어가면 안 된다
const EXCLUDE = new Set(["wallet.json", "privateKey", "node_key", ".DS_Store"]);

const walk = (rel, out) => {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    return out;
  }
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(full).sort()) {
      walk(path.join(rel, entry), out);
    }
    return out;
  }
  if (EXCLUDE.has(path.basename(rel))) {
    console.log(`  건너뜀: ${rel}`);
    return out;
  }
  out.push(rel);
  return out;
};

const files = INCLUDE.reduce((out, entry) => walk(entry, out), []).sort();
if (files.length === 0) {
  console.error("담을 파일이 없습니다");
  process.exit(1);
}

const gitCommit = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

/*
 * 판번호와 커밋을 파일 하나에 적어 넣는다. 노드가 뜰 때 이걸 읽을 수 있으면
 * "지금 돌고 있는 것이 정확히 무엇인지"를 로그만 보고 알 수 있다.
 */
const buildInfo = {
  name: "limcoin",
  version,
  commit: gitCommit(),
  files: files.length,
  builtBy: "scripts/release.js"
};
const stagingRoot = path.join(DIST, name);
for (const rel of files) {
  const to = path.join(stagingRoot, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), to);
}
fs.writeFileSync(path.join(stagingRoot, "BUILD.json"), JSON.stringify(buildInfo, null, 2) + "\n");

const tarball = path.join(DIST, `${name}.tar.gz`);
/*
 * 재현 가능한 tar:
 *   --sort=name        이름순 (파일시스템 순서에 기대지 않는다)
 *   --mtime            시각 고정
 *   --owner/--group    소유자 고정 (내 uid 가 들어가면 남과 달라진다)
 *   --mode             권한 고정
 *   gzip -n            gzip 헤더에 시각·이름을 넣지 않는다
 */
execFileSync(
  "tar",
  [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=go-rwx,u+rw,a+X",
    "--use-compress-program=gzip -9 -n",
    "-cf",
    tarball,
    "-C",
    DIST,
    `${name}/BUILD.json`,
    ...files.map(rel => `${name}/${rel}`)
  ],
  { stdio: "inherit" }
);
fs.rmSync(stagingRoot, { recursive: true, force: true });

const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const artifacts = [tarball];
const sums = artifacts.map(file => `${sha256(file)}  ${path.basename(file)}`).join("\n") + "\n";
fs.writeFileSync(path.join(DIST, "SHA256SUMS"), sums);

console.log(`\n${name}`);
console.log(`  커밋   ${buildInfo.commit || "(git 아님)"}`);
console.log(`  파일   ${files.length}개`);
for (const file of artifacts) {
  console.log(`  ${path.basename(file)}  ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
}
console.log(`\ndist/SHA256SUMS:\n${sums}`);
console.log("확인:  cd dist && sha256sum -c SHA256SUMS");
