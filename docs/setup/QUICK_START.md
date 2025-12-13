# 빠른 시작 가이드

## 1. 하드웨어 준비

### 필요 장비

| 장비 | 수량 | 권장 사양 |
|------|------|----------|
| 워커PC | 2대 | CPU 16코어, RAM 64GB, USB 3.0 허브 |
| WiFi 라우터 | 2대 | 150+ 클라이언트 지원 |
| Android 스마트폰 | 260대 | Android 8.0+, USB 디버깅 가능 |
| USB 허브 | 필요시 | USB 3.0, 충전 지원 |
| VM 서버 | 1대 | CPU 8코어, RAM 16GB (클라우드 가능) |

---

## 2. 네트워크 설정

### 2.1 WiFi 라우터 설정

**라우터 #1:**
```
SSID: auto-net-1
보안: WPA2-PSK
비밀번호: [강력한 비밀번호]
IP 대역: 192.168.1.0/24
DHCP 범위: 192.168.1.10 - 192.168.1.200
WAN: 비활성화 (케이블 연결 안함)
```

**라우터 #2:**
```
SSID: auto-net-2
보안: WPA2-PSK
비밀번호: [강력한 비밀번호]
IP 대역: 192.168.2.0/24
DHCP 범위: 192.168.2.10 - 192.168.2.200
WAN: 비활성화
```

### 2.2 워커PC 네트워크

**워커PC #1:**
```
NIC 1 (외부 연결): DHCP 또는 고정 IP
NIC 2 (WiFi 라우터 연결): 192.168.1.1 (게이트웨이로 설정)
```

**워커PC #2:**
```
NIC 1 (외부 연결): DHCP 또는 고정 IP
NIC 2 (WiFi 라우터 연결): 192.168.2.1
```

---

## 3. 스마트폰 설정

### 3.1 개발자 옵션 활성화

1. 설정 > 휴대전화 정보
2. 빌드번호 7회 탭
3. 개발자 옵션 활성화 확인

### 3.2 USB 디버깅 활성화

```
설정 > 개발자 옵션:
- USB 디버깅: ON
- USB 디버깅 승인 취소: 탭 (기존 승인 초기화)
```

### 3.3 ADB over WiFi 활성화

USB로 연결 후:
```bash
# ADB TCP/IP 모드 활성화
adb tcpip 5555

# WiFi IP 확인
adb shell ip addr show wlan0 | grep inet

# 연결 테스트
adb connect 192.168.1.10:5555
```

### 3.4 추가 설정

```
설정 > 디스플레이:
- 화면 자동 꺼짐: 절대 안함 (또는 최대)
- 적응형 밝기: OFF

설정 > 배터리:
- 배터리 최적화: 해당 앱 제외
- 절전 모드: OFF

설정 > 연결:
- WiFi: auto-net-1 또는 auto-net-2 연결
- 모바일 데이터: ON (유심 사용)
```

---

## 4. 제어서버 설정 (VM)

### 4.1 Ubuntu 설치

```bash
# 패키지 업데이트
sudo apt update && sudo apt upgrade -y

# 필수 패키지 설치
sudo apt install -y curl git build-essential

# Node.js 20 LTS 설치
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Redis 설치
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server

# PostgreSQL 설치 (선택)
sudo apt install -y postgresql postgresql-contrib
```

### 4.2 WireGuard VPN 설정

```bash
# WireGuard 설치
sudo apt install -y wireguard

# 키 생성
wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key
chmod 600 /etc/wireguard/private.key

# 설정 파일 생성
sudo nano /etc/wireguard/wg0.conf
```

**wg0.conf:**
```ini
[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = <서버_개인키>
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT

# 관리자 클라이언트
[Peer]
PublicKey = <클라이언트_공개키>
AllowedIPs = 10.0.0.2/32
```

```bash
# VPN 시작
sudo systemctl enable wg-quick@wg0
sudo systemctl start wg-quick@wg0
```

### 4.3 제어서버 배포

```bash
# 프로젝트 클론
git clone https://github.com/exe-blue/android-auto.git
cd android-auto/apps/control-server

# 의존성 설치
npm install

# 환경 변수 설정
cp .env.example .env
nano .env
```

**.env:**
```env
PORT=3000
REDIS_URL=redis://localhost:6379
VPN_SUBNET=10.0.0.0/24
NODE_ENV=production
```

```bash
# PM2로 실행
npm install -g pm2
pm2 start dist/api/server.js --name control-server
pm2 save
pm2 startup
```

---

## 5. 워커PC 설정

### 5.1 Ubuntu 설치 및 설정

```bash
# 패키지 업데이트
sudo apt update && sudo apt upgrade -y

# 필수 패키지 설치
sudo apt install -y curl git build-essential android-tools-adb

# Node.js 20 LTS 설치
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# ADB udev 규칙 (USB 기기용)
sudo usermod -aG plugdev $USER
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="*", MODE="0666", GROUP="plugdev"' | sudo tee /etc/udev/rules.d/51-android.rules
sudo udevadm control --reload-rules
```

### 5.2 워커 에이전트 배포

```bash
# 프로젝트 클론
cd android-auto/apps/worker-agent

# 의존성 설치
npm install

# 환경 변수 설정
cp .env.example .env
nano .env
```

**워커 #1 .env:**
```env
WORKER_ID=1
CONTROL_SERVER_URL=ws://10.0.0.1:3000/ws
WIFI_SUBNET=192.168.1
MAX_CONCURRENT=50
HEARTBEAT_INTERVAL=10000
ADB_PORT=5555
```

**워커 #2 .env:**
```env
WORKER_ID=2
CONTROL_SERVER_URL=ws://10.0.0.1:3000/ws
WIFI_SUBNET=192.168.2
MAX_CONCURRENT=50
HEARTBEAT_INTERVAL=10000
ADB_PORT=5555
```

```bash
# PM2로 실행
pm2 start dist/workerAgent.js --name worker-agent
pm2 save
pm2 startup
```

---

## 6. 테스트

### 6.1 연결 테스트

```bash
# 워커PC에서 기기 연결 확인
adb devices -l

# 예상 출력:
# 192.168.1.10:5555    device product:... model:... device:...
# 192.168.1.11:5555    device product:... model:... device:...
# ...
```

### 6.2 API 테스트

```bash
# VPN 연결 후

# 기기 통계 확인
curl http://10.0.0.1:3000/api/devices/stats

# 사용 가능한 기기 확인
curl http://10.0.0.1:3000/api/devices/available

# 테스트 작업 실행
curl -X POST http://10.0.0.1:3000/api/tasks/execute \
  -H "Content-Type: application/json" \
  -d '{"commandType": "command_a", "targetCount": 10}'

# 작업 상태 확인
curl http://10.0.0.1:3000/api/tasks/{taskId}
```

### 6.3 점진적 확장

| 단계 | 기기 수 | 검증 항목 |
|------|--------|----------|
| 1단계 | 10대 | 기본 연결 및 명령 실행 |
| 2단계 | 50대 | 동시 실행 성능 |
| 3단계 | 130대 | 워커 1대 풀 테스트 |
| 4단계 | 260대 | 전체 시스템 테스트 |

---

## 7. 모니터링

### 7.1 PM2 모니터링

```bash
# 프로세스 상태
pm2 status

# 로그 확인
pm2 logs control-server
pm2 logs worker-agent

# 리소스 모니터링
pm2 monit
```

### 7.2 시스템 모니터링

```bash
# CPU/메모리 사용량
htop

# 네트워크 연결
netstat -an | grep 5555 | wc -l

# ADB 연결 상태
adb devices | grep device | wc -l
```

---

## 8. 문제 해결

### 기기 연결 안됨

```bash
# ADB 서버 재시작
adb kill-server
adb start-server

# 기기에서 ADB 재활성화
adb -s <serial> tcpip 5555

# 방화벽 확인
sudo ufw status
sudo ufw allow 5555/tcp
```

### 명령 실행 실패

```bash
# 화면 상태 확인
adb -s <serial> shell dumpsys power | grep mScreenOn

# 화면 켜기
adb -s <serial> shell input keyevent KEYCODE_WAKEUP

# 현재 액티비티 확인
adb -s <serial> shell dumpsys activity activities | grep mResumedActivity
```

### 성능 저하

```bash
# 워커PC 리소스 확인
free -h
df -h

# ADB 연결 수 제한 확인
echo "net.ipv4.tcp_max_syn_backlog = 65535" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

---

## 다음 단계

1. [커맨드 커스터마이징](./COMMANDS.md)
2. [모니터링 대시보드 설정](./MONITORING.md)
3. [고급 설정](./ADVANCED.md)

