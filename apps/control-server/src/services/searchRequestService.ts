/**
 * 검색 요청 서비스
 * 키워드, 제목, 주소로 콘텐츠 검색 요청 관리
 */

import Redis from 'ioredis';

// 검색 요청 상태
export type SearchRequestStatus = 'pending' | 'processing' | 'found' | 'not_found' | 'failed';

// 검색 단계
export type SearchPhase = 'keyword' | 'title' | 'url' | 'completed';

// 검색 요청 정보
export interface SearchRequest {
  id: string;
  userId: string;
  keyword: string;           // 검색 키워드
  title: string;             // 콘텐츠 제목
  url: string;               // 외부 URL (폴백용)
  status: SearchRequestStatus;
  currentPhase: SearchPhase;
  assignedDevices: string[]; // 할당된 기기 목록
  completedDevices: number;
  foundBy?: string;          // 찾은 기기 ID
  foundAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  priority: number;          // 우선순위 (높을수록 먼저)
}

// 검색 요청 생성 입력
export interface CreateSearchRequest {
  userId: string;
  keyword: string;
  title: string;
  url: string;
  priority?: number;
}

// 검색 결과
export interface SearchResult {
  requestId: string;
  deviceId: string;
  phase: SearchPhase;
  found: boolean;
  screenshotPath?: string;
  durationMs: number;
  errorMessage?: string;
}

export class SearchRequestService {
  private redis: Redis;
  
  // 검색 요청 큐 키
  private static QUEUE_KEY = 'search_requests:queue';
  private static REQUESTS_KEY = 'search_requests:all';

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  /**
   * 검색 요청 생성
   */
  async createRequest(input: CreateSearchRequest): Promise<SearchRequest> {
    const request: SearchRequest = {
      id: `search_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId: input.userId,
      keyword: input.keyword,
      title: input.title,
      url: input.url,
      status: 'pending',
      currentPhase: 'keyword',
      assignedDevices: [],
      completedDevices: 0,
      createdAt: new Date(),
      priority: input.priority || 10
    };

    // 요청 저장
    await this.redis.hset(
      SearchRequestService.REQUESTS_KEY,
      request.id,
      JSON.stringify(request)
    );

    // 큐에 추가 (우선순위 점수로 정렬)
    await this.redis.zadd(
      SearchRequestService.QUEUE_KEY,
      request.priority,
      request.id
    );

    console.log(`검색 요청 생성: ${request.id} (키워드: ${request.keyword})`);
    return request;
  }

  /**
   * 대기 중인 다음 요청 가져오기
   */
  async getNextPendingRequest(): Promise<SearchRequest | null> {
    // 가장 높은 우선순위 요청 조회 (제거하지 않음)
    const requestIds = await this.redis.zrevrange(SearchRequestService.QUEUE_KEY, 0, 0);
    
    if (requestIds.length === 0) {
      return null;
    }

    const requestJson = await this.redis.hget(
      SearchRequestService.REQUESTS_KEY,
      requestIds[0]
    );

    if (!requestJson) {
      // 큐에서 제거 (데이터 불일치)
      await this.redis.zrem(SearchRequestService.QUEUE_KEY, requestIds[0]);
      return null;
    }

    const request: SearchRequest = JSON.parse(requestJson);
    
    // pending 상태만 반환
    if (request.status !== 'pending') {
      return null;
    }

    return request;
  }

  /**
   * 요청 처리 시작
   */
  async startProcessing(requestId: string, deviceIds: string[]): Promise<SearchRequest | null> {
    const requestJson = await this.redis.hget(
      SearchRequestService.REQUESTS_KEY,
      requestId
    );

    if (!requestJson) {
      return null;
    }

    const request: SearchRequest = JSON.parse(requestJson);
    request.status = 'processing';
    request.assignedDevices = deviceIds;
    request.startedAt = new Date();

    await this.redis.hset(
      SearchRequestService.REQUESTS_KEY,
      requestId,
      JSON.stringify(request)
    );

    // 큐에서 제거
    await this.redis.zrem(SearchRequestService.QUEUE_KEY, requestId);

    console.log(`검색 요청 처리 시작: ${requestId} (${deviceIds.length}대 할당)`);
    return request;
  }

  /**
   * 검색 결과 업데이트
   */
  async updateResult(result: SearchResult): Promise<SearchRequest | null> {
    const requestJson = await this.redis.hget(
      SearchRequestService.REQUESTS_KEY,
      result.requestId
    );

    if (!requestJson) {
      return null;
    }

    const request: SearchRequest = JSON.parse(requestJson);
    request.completedDevices++;

    if (result.found) {
      // 찾음!
      request.status = 'found';
      request.foundBy = result.deviceId;
      request.foundAt = new Date();
      request.completedAt = new Date();
      console.log(`검색 성공: ${request.id} (${result.phase} 단계, 기기: ${result.deviceId})`);
    } else if (result.errorMessage) {
      // 오류 발생
      request.errorMessage = result.errorMessage;
    }

    // 모든 기기가 완료되었는데 못 찾은 경우
    if (request.completedDevices >= request.assignedDevices.length && request.status === 'processing') {
      // 다음 단계로 진행
      if (request.currentPhase === 'keyword') {
        request.currentPhase = 'title';
        request.completedDevices = 0;
        console.log(`검색 요청 ${request.id}: 제목 검색 단계로 진행`);
      } else if (request.currentPhase === 'title') {
        request.currentPhase = 'url';
        request.completedDevices = 0;
        console.log(`검색 요청 ${request.id}: URL 이동 단계로 진행`);
      } else if (request.currentPhase === 'url') {
        request.status = 'not_found';
        request.currentPhase = 'completed';
        request.completedAt = new Date();
        console.log(`검색 요청 ${request.id}: 모든 단계 실패`);
      }
    }

    await this.redis.hset(
      SearchRequestService.REQUESTS_KEY,
      result.requestId,
      JSON.stringify(request)
    );

    return request;
  }

  /**
   * 요청 상태 조회
   */
  async getRequest(requestId: string): Promise<SearchRequest | null> {
    const requestJson = await this.redis.hget(
      SearchRequestService.REQUESTS_KEY,
      requestId
    );

    if (!requestJson) {
      return null;
    }

    return JSON.parse(requestJson);
  }

  /**
   * 사용자의 요청 목록 조회
   */
  async getUserRequests(userId: string, limit: number = 20): Promise<SearchRequest[]> {
    const allRequests = await this.redis.hgetall(SearchRequestService.REQUESTS_KEY);
    const userRequests: SearchRequest[] = [];

    for (const json of Object.values(allRequests)) {
      const request: SearchRequest = JSON.parse(json);
      if (request.userId === userId) {
        userRequests.push(request);
      }
    }

    // 최신순 정렬
    userRequests.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return userRequests.slice(0, limit);
  }

  /**
   * 대기 중인 요청 수
   */
  async getPendingCount(): Promise<number> {
    return await this.redis.zcard(SearchRequestService.QUEUE_KEY);
  }

  /**
   * 처리 중인 요청 목록
   */
  async getProcessingRequests(): Promise<SearchRequest[]> {
    const allRequests = await this.redis.hgetall(SearchRequestService.REQUESTS_KEY);
    const processingRequests: SearchRequest[] = [];

    for (const json of Object.values(allRequests)) {
      const request: SearchRequest = JSON.parse(json);
      if (request.status === 'processing') {
        processingRequests.push(request);
      }
    }

    return processingRequests;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

