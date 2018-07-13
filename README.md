# LimCoin
LimCoin, the coin made in NodeJS



## 블록체인 원리 이해하기
-----------------------------

기본 환경
-  Nodejs , Npm 설치
-  Yarn 설치


------------------------------


- Block 구조체 만들기
#3

- BlockChain 에 Block 추가하기
#6

- Send Messages P2P and Actions 싱크 Chain
#12

- Broadcasting
#13


--------------------------

###  사용 라이브러리
- hex-to-binary 
- lodash 
- elliptic
- Express
- body-parser
- morgan
- cors
- crypto, crypto-js
- js
- lodash
- nodemon
- ws

-----------------

### Version infomation
    "body-parser": "^1.18.2",
    "cors": "^2.8.4",
    "crypto": "^1.0.1",
    "crypto-js": "^3.1.9-1",
    "elliptic": "^6.4.0",
    "express": "^4.16.3",
    "hex-to-binary": "^1.0.1",
    "js": "^0.1.0",
    "lodash": "^4.17.10",
    "morgan": "^1.9.0",
    "nodemon": "^1.17.3",
    "ws": "^5.1.1"


# 주요 사용 Function 정리
### blockchain.js
1. genesisTx, genesisBlock 초기 제네시스 Tx, block 생성 함수
2. getNewestBlock 새로운(가장 최근) 블럭 가져오기 함수
3. hashMatchesDifficulty, calculateNewDifficulty 난이도 계산, 설정 함수
4. createHash 해쉬 만들기 함수 CryptoJS 사용




 ### memPool.js

 ### p2p.js
 
 ### server.js

 ### transaction.js

 ### utils.js


 ### wallet.js
