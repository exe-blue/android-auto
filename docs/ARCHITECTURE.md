# Android 자동화 인프라 아키텍처

## 개요

260대의 Android 스마트폰을 동시에 제어하는 분산 자동화 시스템

---

## 네트워크 토폴로지

```
                                    ┌─────────────────────────────────────────┐
                                    │            외부 인터넷 (VPN)              │
                                    └──────────────────┬──────────────────────┘
                                                       │
                                                       ▼
                                    ┌─────────────────────────────────────────┐
                                    │         VM 중계 제어서버 (24/7)          │
                                    │  - Appium Grid Controller               │
                                    │  - Task Queue (Redis)                   │
                                    │  - Dashboard & Monitoring               │
                                    │  - VPN Server (WireGuard)               │
                                    └──────────────────┬──────────────────────┘
                                                       │
                              ┌────────────────────────┴────────────────────────┐
                              │                                                  │
                    ┌─────────▼─────────┐                          ┌─────────────▼─────────┐
                    │   워커PC #1        │                          │   워커PC #2            │
                    │   (130대 담당)     │                          │   (130대 담당)         │
                    │                    │                          │                        │
                    │ [LAN1: 외부연결]   │                          │ [LAN1: 외부연결]       │
                    │ [LAN2: WiFi NAT1]  │                          │ [LAN2: WiFi NAT2]      │
                    │                    │                          │                        │
                    │ - Appium Server    │                          │ - Appium Server        │
                    │ - ADB Hub          │                          │ - ADB Hub              │
                    │ - Worker Agent     │                          │ - Worker Agent         │
                    └─────────┬──────────┘                          └─────────────┬──────────┘
                              │                                                    │
                    ┌─────────▼─────────┐                          ┌───────────────▼────────┐
                    │   WiFi Router #1   │                          │   WiFi Router #2       │
                    │   (NAT, 폐쇄망)    │                          │   (NAT, 폐쇄망)        │
                    │   192.168.1.0/24   │                          │   192.168.2.0/24       │
                    │   No WAN           │                          │   No WAN               │
                    └─────────┬──────────┘                          └───────────────┬────────┘
                              │                                                      │
              ┌───────────────┼───────────────┐                  ┌───────────────────┼───────────────┐
              │               │               │                  │                   │               │
        ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐      ┌─────▼─────┐       ┌─────▼─────┐   ┌─────▼─────┐
        │ Phone 001 │   │ Phone 002 │   │    ...    │      │ Phone 131 │       │ Phone 132 │   │    ...    │
        │           │   │           │   │           │      │           │       │           │   │           │
        │ WiFi: ADB │   │ WiFi: ADB │   │ WiFi: ADB │      │ WiFi: ADB │       │ WiFi: ADB │   │ WiFi: ADB │
        │ LTE: Data │   │ LTE: Data │   │ LTE: Data │      │ LTE: Data │       │ LTE: Data │   │ LTE: Data │
        └───────────┘   └───────────┘   └───────────┘      └───────────┘       └───────────┘   └───────────┘
```

---

## 구성 요소

### 1. VM 중계 제어서버

| 항목 | 사양 |
|------|------|
| OS | Ubuntu 22.04 LTS |
| CPU | 8 Core 이상 |
| RAM | 16GB 이상 |
| Storage | SSD 500GB |
| Network | 고정 IP, 방화벽 설정 |

**서비스 구성:**
- **WireGuard VPN**: 관리자 전용 접근
- **Redis**: 작업 큐 및 상태 관리
- **PostgreSQL**: 로그 및 결과 저장
- **Node.js API Server**: 명령 수신 및 분배
- **Grafana + Prometheus**: 모니터링

### 2. 워커PC (x2)

| 항목 | 사양 |
|------|------|
| OS | Ubuntu 22.04 LTS |
| CPU | 16 Core 이상 |
| RAM | 64GB 이상 |
| Storage | SSD 1TB |
| USB | USB 3.0 Hub (130포트 확장) |
| NIC | 듀얼 LAN 포트 |

**소프트웨어:**
- Appium Server (포트별 멀티 인스턴스)
- ADB Server
- Worker Agent (Node.js)
- Docker (선택)

### 3. WiFi Router (x2)

| 설정 | 값 |
|------|-----|
| SSID | `auto-net-1`, `auto-net-2` |
| Security | WPA2-PSK |
| DHCP Range | 192.168.x.10 - 192.168.x.200 |
| WAN | 비활성화 (폐쇄망) |
| Max Clients | 150+ |

### 4. Android 스마트폰 (260대)

**필수 설정:**
- USB 디버깅 활성화
- ADB over WiFi 활성화 (5555 포트)
- 화면 꺼짐 방지
- 유심칩 (LTE/5G 데이터)
- 절전모드 비활성화

---

## 시스템 흐름

### 명령 실행 흐름

```
┌─────────┐     VPN      ┌─────────────┐    TCP     ┌───────────┐    ADB    ┌──────────┐
│ 관리자   │ ──────────▶ │ 제어서버 VM  │ ────────▶ │ 워커PC    │ ────────▶ │ 스마트폰  │
└─────────┘              └─────────────┘            └───────────┘           └──────────┘
     │                         │                         │                       │
     │  1. 명령 발송            │  2. 가용 폰 계산         │  3. ADB 명령 실행     │
     │  (커맨드 A/B/C)         │  3. 작업 분배            │  4. 결과 수집          │
     │                         │                         │                       │
     │                         │  ◀──────────────────────┼───────────────────────┤
     │                         │  5. 결과 취합 & 로깅                              │
     │  ◀──────────────────────┤  6. 응답 반환                                    │
     │                         │                                                  │
```

### 오류 처리 흐름

```
┌──────────────┐
│ 명령 실행     │
└──────┬───────┘
       │
       ▼
┌──────────────┐     No      ┌──────────────┐
│ 성공 여부?    │ ──────────▶ │ 스크린샷 캡처 │
└──────┬───────┘             └──────┬───────┘
       │ Yes                        │
       ▼                            ▼
┌──────────────┐             ┌──────────────┐
│ 결과 로깅     │             │ ADB 재연결    │
└──────────────┘             └──────┬───────┘
                                    │
                                    ▼
                             ┌──────────────┐
                             │ 앱 재시작     │
                             └──────┬───────┘
                                    │
                                    ▼
                             ┌──────────────┐
                             │ 재시도 (3회)  │
                             └──────────────┘
```

---

## 포트 할당 계획

### 제어서버 VM

| 서비스 | 포트 |
|--------|------|
| WireGuard VPN | 51820/UDP |
| API Server | 3000 |
| Redis | 6379 |
| PostgreSQL | 5432 |
| Grafana | 3001 |
| Prometheus | 9090 |

### 워커PC

| 서비스 | 포트 범위 |
|--------|----------|
| Appium Servers | 4723-4852 (130개) |
| ADB Connections | 5555 (각 폰) |
| Worker Agent | 5000 |
| System Port | 8200-8329 (130개) |

---

## 데이터베이스 스키마

### devices (기기 정보)

```sql
CREATE TABLE devices (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(64) UNIQUE NOT NULL,
    worker_id INTEGER NOT NULL,
    ip_address VARCHAR(45),
    phone_number VARCHAR(20),
    status VARCHAR(20) DEFAULT 'idle',  -- idle, busy, error, offline
    last_seen TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### tasks (작업 정보)

```sql
CREATE TABLE tasks (
    id SERIAL PRIMARY KEY,
    command_type VARCHAR(20) NOT NULL,  -- command_a, command_b, command_c
    status VARCHAR(20) DEFAULT 'pending',
    total_devices INTEGER,
    completed_devices INTEGER DEFAULT 0,
    failed_devices INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);
```

### execution_logs (실행 로그)

```sql
CREATE TABLE execution_logs (
    id SERIAL PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id),
    device_id INTEGER REFERENCES devices(id),
    status VARCHAR(20),  -- success, failed, timeout
    duration_ms INTEGER,
    error_message TEXT,
    screenshot_path VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 자동화 커맨드 구조

### 커맨드 정의

```typescript
// commands/index.ts
export enum CommandType {
  COMMAND_A = 'command_a',
  COMMAND_B = 'command_b',
  COMMAND_C = 'command_c'
}

export interface CommandConfig {
  type: CommandType;
  steps: Step[];
  timeout: number;  // ms
  retryCount: number;
}

export interface Step {
  action: 'tap' | 'swipe' | 'type' | 'wait' | 'screenshot';
  selector?: string;
  value?: string;
  duration?: number;
  coordinates?: { x: number; y: number };
}
```

### 커맨드 로테이션

```typescript
// scheduler/rotation.ts
class CommandRotation {
  private commands = [
    CommandType.COMMAND_A,
    CommandType.COMMAND_B,
    CommandType.COMMAND_C
  ];
  private currentIndex = 0;

  getNextCommand(): CommandType {
    const command = this.commands[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.commands.length;
    return command;
  }
}
```

---

## 보안 설정

### VPN 접근 제어

```ini
# /etc/wireguard/wg0.conf (제어서버)
[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = <SERVER_PRIVATE_KEY>

# 관리자 클라이언트
[Peer]
PublicKey = <ADMIN_PUBLIC_KEY>
AllowedIPs = 10.0.0.2/32
```

### 방화벽 규칙

```bash
# 제어서버 UFW 설정
ufw default deny incoming
ufw default allow outgoing

# VPN 포트만 외부 허용
ufw allow 51820/udp

# VPN 네트워크에서만 서비스 접근 허용
ufw allow from 10.0.0.0/24 to any port 3000  # API
ufw allow from 10.0.0.0/24 to any port 3001  # Grafana

# 워커PC와의 내부 통신
ufw allow from 192.168.0.0/16 to any port 6379  # Redis
```

---

## 모니터링 대시보드

### 주요 메트릭

| 메트릭 | 설명 |
|--------|------|
| `devices_online_total` | 온라인 기기 수 |
| `devices_busy_total` | 작업 중인 기기 수 |
| `tasks_completed_total` | 완료된 작업 수 |
| `tasks_failed_total` | 실패한 작업 수 |
| `command_duration_seconds` | 명령 실행 시간 |
| `error_rate` | 오류 발생률 |

### 알림 설정

```yaml
# alertmanager/alerts.yml
groups:
  - name: device-alerts
    rules:
      - alert: DeviceOffline
        expr: devices_online_total < 250
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "온라인 기기 수 부족"

      - alert: HighErrorRate
        expr: error_rate > 0.1
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "오류율 10% 초과"
```

---

## 스케일링 고려사항

### 현재 구성 (260대)

- 워커PC 2대 × 130대/PC = 260대
- 각 PC에서 Appium 인스턴스 130개 동시 실행

### 확장 시 (500대+)

- 워커PC 추가 (4대 이상)
- 제어서버 클러스터링 (Redis Cluster)
- 로드밸런서 도입

---

## 예상 비용

| 항목 | 월 비용 (KRW) |
|------|--------------|
| VM 제어서버 (클라우드) | ~100,000 |
| 워커PC 전기료 (2대) | ~30,000 |
| 유심 데이터 (260장) | ~2,600,000 |
| WiFi 라우터 유지보수 | ~10,000 |
| **합계** | **~2,740,000** |

---

## 다음 단계

1. [ ] 하드웨어 구매 및 설치
2. [ ] 네트워크 구성 및 테스트
3. [ ] 제어서버 VM 설정
4. [ ] 워커PC 소프트웨어 설치
5. [ ] 스마트폰 초기 설정 (260대)
6. [ ] 통합 테스트 (10대 → 50대 → 260대)
7. [ ] 모니터링 대시보드 구축
8. [ ] 자동화 커맨드 개발

