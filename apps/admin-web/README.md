# Android 자동화 제어 센터 웹앱

Web Awesome을 사용한 관리자 대시보드

## 기능

- ✅ 아이디/비밀번호 로그인 (JWT 인증)
- ✅ 대시보드 (기기 통계, 스케줄러 상태)
- ✅ 검색 요청 등록 (키워드, 제목, URL)
- ✅ 검색 요청 목록 조회
- ✅ 스케줄러 제어 (시작/중지/새로고침)
- ✅ 비밀번호 변경 (설정 페이지)

## 시작하기

### 1. 의존성 설치

```bash
cd apps/admin-web
npm install
```

### 2. 제어서버 실행

웹앱은 제어서버 API와 통신합니다. 제어서버가 실행 중이어야 합니다:

```bash
cd ../control-server
npm install
npm run dev  # 포트 3000에서 실행
```

### 3. 웹앱 실행

제어서버가 `/dist`와 `/admin-web` 정적 파일을 자동으로 서빙합니다.

브라우저에서 접속:
```
http://localhost:3000
```

또는 독립적으로 실행 (개발용):
```bash
cd apps/admin-web
npm run serve  # 포트 8080
```

## 기본 계정

- **아이디**: `admin`
- **비밀번호**: `admin1234`

> ⚠️ 처음 로그인 후 반드시 비밀번호를 변경해주세요!

## 파일 구조

```
apps/admin-web/
├── index.html      # 메인 HTML (로그인 + 대시보드)
├── app.js          # JavaScript 로직 (API 클라이언트)
├── styles.css      # 커스텀 스타일
├── package.json    # 의존성
└── README.md       # 이 파일
```

## Web Awesome 사용

웹앱은 Web Awesome Pro를 사용합니다:

1. **CDN** (기본): `https://kit.webawesome.com/338bd0ebe3844a80.js`
2. **로컬 dist** (폴백): `/dist` 디렉토리

로컬 dist는 프로젝트 루트의 `/dist` 디렉토리를 사용합니다.

## API 엔드포인트

웹앱은 다음 API와 통신합니다:

- `POST /api/auth/login` - 로그인
- `GET /api/auth/me` - 사용자 정보
- `POST /api/search-requests` - 검색 요청 생성
- `GET /api/search-requests` - 요청 목록
- `GET /api/scheduler/status` - 스케줄러 상태
- `POST /api/scheduler/start` - 스케줄러 시작
- `POST /api/scheduler/stop` - 스케줄러 중지

자세한 내용은 `apps/control-server/src/api/server.ts` 참조

## 개발

### 환경 변수

제어서버에서 다음 환경 변수를 설정할 수 있습니다:

```bash
API_URL=http://localhost:3000/api  # 웹앱에서 사용할 API URL
PORT=3000                          # 제어서버 포트
REDIS_URL=redis://localhost:6379   # Redis URL
NODE_ENV=development               # 개발 모드 (VPN 검증 스킵)
```

### 수정사항 반영

- HTML/CSS/JS 수정 시: 브라우저 새로고침
- 제어서버 코드 수정 시: 서버 재시작

## 배포

제어서버와 함께 배포됩니다. 제어서버가 정적 파일을 자동으로 서빙합니다.

```bash
cd apps/control-server
npm run build
npm start
```

브라우저에서 접속:
```
http://your-server:3000
```

## 문제 해결

### 로그인 실패

- 기본 계정이 없으면 제어서버 시작 시 자동 생성됩니다
- Redis가 실행 중인지 확인하세요

### API 연결 실패

- 제어서버가 실행 중인지 확인
- CORS 설정 확인 (개발 환경에서는 `*` 허용)
- 브라우저 콘솔에서 오류 확인

### Web Awesome 컴포넌트가 표시되지 않음

- CDN이 차단되었는지 확인
- `/dist` 디렉토리가 올바른 위치에 있는지 확인
- 브라우저 콘솔에서 스크립트 로드 오류 확인

