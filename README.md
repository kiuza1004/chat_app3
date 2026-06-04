# Simple Chat App

심플한 실시간 채팅 웹앱. 아이디/비밀번호로 가입·로그인하고, 채팅방을 만들어 메시지를 주고받습니다.

## 기술 스택

- **백엔드**: Node.js + Express + Socket.IO
- **DB**: JSON 파일 기반 저장소 (`chat-data.json`)
- **인증**: express-session + bcryptjs
- **프론트**: Vanilla HTML/CSS/JS

## 기능

- 회원가입 / 로그인 / 로그아웃
- 채팅방 생성
- 채팅방 입장 후 실시간 메시지 송수신
- 채팅방별 메시지 기록 보관 (최근 200개 로드)

## 실행 방법

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000 으로 접속.

## 환경변수 (선택)

- `PORT` — 서버 포트 (기본 3000)
- `SESSION_SECRET` — 세션 시크릿 (운영 환경에서는 반드시 설정)

## 디렉토리 구조

```
chat_app3/
├── server.js          # Express + Socket.IO 서버
├── db.js              # JSON 파일 저장소
├── package.json
├── public/
│   ├── index.html     # 로그인/회원가입
│   ├── chat.html      # 채팅 UI
│   ├── style.css
│   └── app.js
└── README.md
```
