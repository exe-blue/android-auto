# PoC 설정 가이드

전체 시스템 개념증명(PoC)을 위한 단계별 설정 가이드입니다.

## 목표

1대의 Android 기기로 전체 시스템을 테스트합니다:
- 제어서버 + 워커 에이전트 연결
- 검색 요청 등록 및 실행
- 웹 대시보드 모니터링

---

## 1. 사전 준비

### 필수 소프트웨어

- **Node.js** 18.x 이상
- **Redis** 6.x 이상
- **Android SDK Platform Tools** (ADB)
- **Java JDK** 17 (Appium 사용 시)

### 체크리스트

```bash
# Node.js 버전 확인
node --version  # v18.x 이상

# Redis 실행 확인
redis-cli ping  # PONG 응답이면 OK

# ADB 경로 확인
adb version     # Android Debug Bridge 버전 표시

# Java 확인 (선택사항)
java -version   # openjdk 17
```

---

## 2. Redis 설치 및 실행

### macOS (Homebrew)

```bash
brew install redis
brew services start redis
```

### Linux (Ubuntu/Debian)

```bash
sudo apt-get update
sudo apt-get install redis-server
sudo systemctl start redis
```

### 수동 실행

```bash
redis-server
```

Redis가 기본 포트 6379에서 실행되는지 확인:
```bash
redis-cli ping
# PONG
```

---

## 3. 제어서버 설정

### 3.1 디렉토리 이동

```bash
cd apps/control-server
```

### 3.2 의존성 설치

```bash
npm install
```

### 3.3 환경 변수 설정

`.env.example`을 복사하여 `.env` 파일 생성:

```bash
cp .env.example .env
```

`.env` 파일 수정 (필요시):

```bash
REDIS_URL=redis://localhost:6379
PORT=3000
NODE_ENV=development
JWT_SECRET=your-secret-key
```

### 3.4 제어서버 실행

```bash
npm run dev
```

콘솔에 다음이 표시되면 성공:

```
=================================
  Android 자동화 제어서버
  HTTP 포트: 3000
  WebSocket: ws://localhost:3000/ws
  Redis: redis://localhost:6379
=================================
```

웹 대시보드 접속: http://localhost:3000

---

## 4. Android 기기 준비 (실제 기기 사용 시)

### 4.1 USB 디버깅 활성화

1. 설정 → 디바이스 정보 → 빌드 번호 7회 탭
2. 설정 → 개발자 옵션 → USB 디버깅 활성화
3. USB로 PC에 연결

### 4.2 WiFi ADB 활성화

```bash
# USB로 연결된 상태에서 실행
adb tcpip 5555

# 기기의 WiFi IP 확인 (설정 → WiFi → 네트워크 정보)
# 예: 192.168.1.100

# USB 케이블 분리 후 WiFi로 연결
adb connect 192.168.1.100:5555

# 연결 확인
adb devices
# 192.168.1.100:5555    device
```

### 4.3 기기 연결 테스트

```bash
# 화면 켜기
adb -s 192.168.1.100:5555 shell input keyevent 26

# 홈 버튼
adb -s 192.168.1.100:5555 shell input keyevent 3
```

---

## 5. 워커 에이전트 설정

### 5.1 디렉토리 이동

```bash
cd apps/worker-agent
```

### 5.2 의존성 설치

```bash
npm install
```

### 5.3 환경 변수 설정

`.env.example`을 복사하여 `.env` 파일 생성:

```bash
cp .env.example .env
```

`.env` 파일 수정:

```bash
WORKER_ID=1
CONTROL_SERVER_URL=ws://localhost:3000/ws
WIFI_SUBNET=192.168.1          # 기기의 WiFi 서브넷
MAX_CONCURRENT=5
HEARTBEAT_INTERVAL=10000
ADB_PORT=5555
SIMULATION_MODE=false           # 실제 기기 사용 시 false
```

**시뮬레이션 모드** (기기 없이 테스트):

기기가 없거나 연결이 안 되는 경우:

```bash
SIMULATION_MODE=true
```

이 모드에서는 실제 ADB 명령 대신 시뮬레이션으로 동작합니다.

### 5.4 워커 에이전트 실행

```bash
npm run dev
# 또는
node dist/src/workerAgent.js
```

콘솔에 다음이 표시되면 성공:

```
=================================
  워커 에이전트 #1
  서브넷: 192.168.1.0/24
  최대 동시 실행: 5
=================================
기기 스캔 시작...
기기 스캔 완료: 1대 연결됨
제어서버 연결 중: ws://localhost:3000/ws
제어서버 연결됨
워커 #1 등록됨 (1대)
```

제어서버 콘솔에서도 확인:

```
WebSocket 연결됨
워커 #1 등록됨 (1대)
```

---

## 6. 웹 대시보드 접속

브라우저에서 http://localhost:3000 접속

### 6.1 로그인

- **아이디**: `admin`
- **비밀번호**: `admin1234`

> ⚠️ 첫 로그인 후 비밀번호를 변경하세요!

### 6.2 대시보드 확인

- **온라인 기기**: 1대 (또는 연결된 기기 수)
- **스케줄러 상태**: 중지됨

### 6.3 스케줄러 시작 (선택)

관리자 권한으로 스케줄러를 시작할 수 있습니다:

1. 대시보드 → 스케줄러 상태
2. "시작" 버튼 클릭

---

## 7. 검색 요청 테스트

### 7.1 검색 요청 등록

1. "검색 요청 등록" 탭 선택
2. 다음 정보 입력:
   - **키워드**: `테스트`
   - **제목**: `테스트 제목`
   - **주소**: `https://example.com`
   - **우선순위**: `10` (기본값)
3. "요청 등록" 버튼 클릭

### 7.2 결과 확인

**시뮬레이션 모드인 경우:**
- 워커 에이전트 콘솔에서 검색 시뮬레이션 로그 확인
- 대시보드에서 요청 상태 업데이트 확인

**실제 기기인 경우:**
- 기기에서 앱이 실행되고 검색이 수행됨
- 결과가 대시보드에 표시됨

### 7.3 요청 목록 확인

"요청 목록" 탭에서:
- 등록한 검색 요청 확인
- 상태 (대기 중, 처리 중, 발견, 미발견) 확인
- 발견 단계 (키워드/제목/URL) 확인

---

## 8. 문제 해결

### 제어서버가 시작되지 않음

```bash
# 포트가 사용 중인지 확인
lsof -i :3000

# Redis 연결 확인
redis-cli ping
```

### 워커가 제어서버에 연결되지 않음

```bash
# 제어서버가 실행 중인지 확인
curl http://localhost:3000/health

# WebSocket 연결 테스트
# 브라우저 콘솔에서:
# const ws = new WebSocket('ws://localhost:3000/ws');
# ws.onopen = () => console.log('Connected');
```

### 기기가 연결되지 않음

```bash
# ADB 서버 재시작
adb kill-server
adb start-server

# 기기 목록 확인
adb devices

# WiFi 연결 재시도
adb connect 192.168.1.100:5555
```

### 시뮬레이션 모드에서 테스트

기기가 없거나 연결 문제가 있을 때:

1. 워커 에이전트 `.env` 파일 수정:
   ```bash
   SIMULATION_MODE=true
   ```

2. 워커 에이전트 재시작

3. 검색 요청 등록 → 시뮬레이션으로 동작함

---

## 9. 다음 단계

PoC 성공 후:

1. **실제 앱 설정**
   - `apps/worker-agent/src/searchCommand.ts`의 `defaultSearchConfig` 수정
   - 앱 패키지명, 좌표 설정

2. **UI Automator 통합**
   - `scrollAndFind` 메서드 구현
   - 실제 텍스트 검색 로직 추가

3. **확장 테스트**
   - 여러 기기로 확장
   - 260대 시스템 테스트

---

## 체크리스트

- [ ] Redis 실행 중
- [ ] 제어서버 실행 중 (포트 3000)
- [ ] 워커 에이전트 실행 중 (제어서버 연결됨)
- [ ] Android 기기 연결됨 (또는 시뮬레이션 모드)
- [ ] 웹 대시보드 접속 및 로그인 성공
- [ ] 검색 요청 등록 및 실행 성공
- [ ] 결과 대시보드에서 확인

---

## 지원

문제가 발생하면:
1. 각 서비스의 콘솔 로그 확인
2. Redis 데이터 확인: `redis-cli KEYS *`
3. 기기 연결 상태 확인: `adb devices`


