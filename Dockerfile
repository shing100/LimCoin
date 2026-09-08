# LimCoin 노드.
#
#   docker build -t limcoin .
#   docker run -p 3000:3000 -v limcoin-data:/data -e LIMCOIN_NETWORK=testnet limcoin
#
# 지갑은 /data/wallet 에, 체인은 /data/chain 에 남는다. 볼륨을 붙이지 않으면
# 컨테이너와 함께 사라진다. 거래소처럼 키를 밖에서 관리하면 LIMCOIN_WALLET=off.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# 의존성 먼저 (소스가 바뀌어도 이 층은 캐시된다)
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY src ./src
COPY scripts ./scripts

# 지갑 파일은 소스 디렉터리가 아니라 볼륨에 둔다
ENV LIMCOIN_WALLET_FILE=/data/wallet/wallet.json \
    LIMCOIN_DATA_DIR=/data/chain \
    HTTP_PORT=3000 \
    LIMCOIN_NETWORK=mainnet
VOLUME ["/data"]
EXPOSE 3000

# 컨테이너는 root 로 돌리지 않는다
RUN mkdir -p /data && chown -R node:node /data /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# 신호를 node 가 직접 받아야 mempool 을 저장하고 워커를 정리한다
CMD ["node", "src/server.js"]
