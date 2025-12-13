# 검색 요청 플로우

## 개요

검색 요청은 사용자가 특정 콘텐츠를 찾기 위해 입력하는 요청입니다.
3단계 폴백 로직으로 콘텐츠를 찾습니다.

## 사용자 입력

| 필드 | 설명 | 예시 |
|------|------|------|
| keyword | 검색 키워드 | "맛집 추천" |
| title | 콘텐츠 제목 | "강남역 숨은 맛집 TOP 10" |
| url | 외부 URL (폴백용) | "https://example.com/content/123" |

## 3단계 검색 로직

```
┌─────────────────────────────────────────────────────────────────┐
│                        검색 요청 시작                            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  1단계: 키워드 검색                                              │
│  ─────────────────────                                          │
│  • 앱 실행 → 검색 버튼 → 키워드 입력                              │
│  • 1시간 이내 필터 적용                                          │
│  • 결과 스크롤하며 제목 찾기                                     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                    찾음? ─┼─ Yes ──→ ✅ 성공 (phase: keyword)
                          │
                          No
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  2단계: 제목 검색                                                │
│  ─────────────────                                              │
│  • 앱 재시작 → 검색 버튼 → 제목 직접 입력                         │
│  • 결과 스크롤하며 정확한 제목 찾기                               │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                    찾음? ─┼─ Yes ──→ ✅ 성공 (phase: title)
                          │
                          No
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  3단계: URL 직접 이동                                            │
│  ─────────────────────                                          │
│  • 외부 브라우저로 URL 열기                                      │
│  • 앱으로 이동 버튼 클릭                                         │
│  • 콘텐츠 페이지 로딩 확인                                       │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                    성공? ─┼─ Yes ──→ ✅ 성공 (phase: url)
                          │
                          No
                          ▼
                     ❌ 실패 (status: not_found)
```

## 버퍼 스케줄러

### 평상시 (검색 요청 없음)

```
자동화1 → 자동화2 → 자동화3 → 자동화1 → 자동화2 → ...
```

### 검색 요청 있을 때

요청과 자동화를 **번갈아** 실행하여 자동화가 버퍼 역할을 함:

```
요청1 → 자동화1 → 요청2 → 자동화2 → 요청3 → 자동화3 → 요청4 → 자동화1 → ...
```

### 스케줄러 로직

```typescript
// 의사 코드
function determineNextJob() {
  const hasPendingRequests = pendingSearchRequests > 0;
  const lastJobType = currentJob?.type;
  
  if (hasPendingRequests) {
    // 검색 요청이 있으면 번갈아 실행
    if (lastJobType === 'automation' || lastJobType === undefined) {
      return nextSearchRequest;  // 요청 실행
    } else {
      return nextAutomation;     // 자동화 실행 (버퍼)
    }
  }
  
  // 검색 요청이 없으면 자동화만 실행
  return nextAutomation;
}
```

## API 엔드포인트

### 인증

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin1234"
}

Response:
{
  "message": "로그인 성공",
  "token": "eyJhbG...",
  "user": {
    "id": "user_admin",
    "username": "admin",
    "role": "admin"
  }
}
```

### 검색 요청 생성

```http
POST /api/search-requests
Authorization: Bearer <token>
Content-Type: application/json

{
  "keyword": "맛집 추천",
  "title": "강남역 숨은 맛집 TOP 10",
  "url": "https://example.com/content/123",
  "priority": 10
}

Response:
{
  "message": "검색 요청이 등록되었습니다",
  "request": {
    "id": "search_1702...",
    "keyword": "맛집 추천",
    "title": "강남역 숨은 맛집 TOP 10",
    "url": "https://example.com/content/123",
    "status": "pending",
    "createdAt": "2025-12-13T..."
  }
}
```

### 검색 요청 상태 조회

```http
GET /api/search-requests/<requestId>
Authorization: Bearer <token>

Response:
{
  "id": "search_1702...",
  "status": "found",
  "currentPhase": "keyword",
  "foundBy": "device_001",
  "foundAt": "2025-12-13T...",
  ...
}
```

### 스케줄러 상태

```http
GET /api/scheduler/status
Authorization: Bearer <token>

Response:
{
  "isRunning": true,
  "currentJob": {
    "id": "job_auto_1702...",
    "type": "automation",
    "commandType": "COMMAND_A"
  },
  "pendingSearchRequests": 3,
  "automationRotationIndex": 1,
  "totalJobsCompleted": 45,
  "totalSearchRequestsCompleted": 12
}
```

## 상태 전이

```
검색 요청 상태:
pending → processing → found / not_found / failed

검색 단계:
keyword → title → url → completed
```

## 설정

```typescript
// 검색 설정 예시
const searchConfig: SearchConfig = {
  appPackage: 'com.example.app',
  searchButtonCoords: { x: 540, y: 150 },
  searchInputCoords: { x: 540, y: 200 },
  resultAreaCoords: { x: 540, y: 600 },
  timeFilterCoords: { x: 900, y: 300 },  // 1시간 필터 버튼
  maxScrolls: 10,
  scrollDelay: 1500
};
```

## 에러 처리

| 에러 | 설명 | 처리 |
|------|------|------|
| 앱 시작 실패 | 앱이 설치되지 않음 | 재시도 후 실패 처리 |
| 검색 실패 | 검색 결과 없음 | 다음 단계로 진행 |
| URL 실패 | 페이지 로딩 실패 | 최종 실패 처리 |
| 기기 오류 | 기기 연결 끊김 | 다른 기기에 재할당 |

## 모니터링

### 대시보드 지표

- 대기 중인 검색 요청 수
- 처리 중인 검색 요청 수
- 평균 검색 성공률 (단계별)
- 평균 검색 소요 시간
- 스케줄러 상태

### 로그

```
[search_1702...] 1단계: 키워드 검색 - "맛집 추천"
[device_001] 콘텐츠 발견: "강남역 숨은 맛집 TOP 10"
검색 성공: search_1702... (keyword 단계, 기기: device_001)
```

