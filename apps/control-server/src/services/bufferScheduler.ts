/**
 * 버퍼 스케줄러
 * 요청과 자동화를 번갈아가며 실행
 * 
 * 동작 방식:
 * - 평상시: 자동화1 → 자동화2 → 자동화3 로테이션
 * - 요청 있을 때: 요청1 → 자동화1 → 요청2 → 자동화2 → ...
 * - 요청이 모두 끝날 때까지 자동화가 버퍼 역할
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { DeviceManager, Device } from './deviceManager';
import { TaskExecutor, CommandType, Task } from './taskExecutor';
import { SearchRequestService, SearchRequest, SearchResult } from './searchRequestService';

// 작업 타입
export type JobType = 'automation' | 'search_request';

// 스케줄러 작업
export interface ScheduledJob {
  id: string;
  type: JobType;
  // 자동화 작업
  commandType?: CommandType;
  // 검색 요청
  searchRequest?: SearchRequest;
  // 실행 정보
  status: 'pending' | 'running' | 'completed' | 'failed';
  assignedDevices: string[];
  startedAt?: Date;
  completedAt?: Date;
}

// 스케줄러 상태
export interface SchedulerStatus {
  isRunning: boolean;
  currentJob: ScheduledJob | null;
  pendingSearchRequests: number;
  automationRotationIndex: number;
  totalJobsCompleted: number;
  totalSearchRequestsCompleted: number;
}

export class BufferScheduler extends EventEmitter {
  private redis: Redis;
  private deviceManager: DeviceManager;
  private taskExecutor: TaskExecutor;
  private searchRequestService: SearchRequestService;
  
  // 상태
  private isRunning: boolean = false;
  private currentJob: ScheduledJob | null = null;
  private automationIndex: number = 0;
  private totalJobsCompleted: number = 0;
  private totalSearchRequestsCompleted: number = 0;
  
  // 자동화 로테이션
  private automationCommands: CommandType[] = [
    CommandType.COMMAND_A,
    CommandType.COMMAND_B,
    CommandType.COMMAND_C
  ];

  // 실행 간격 (ms)
  private jobInterval: number = 5000;

  // 검색 요청 전송 함수
  private searchRequestSender: ((requestId: string, searchInput: { keyword: string; title: string; url: string }, deviceIds: string[]) => Promise<any>) | null = null;

  constructor(
    redisUrl: string,
    deviceManager: DeviceManager,
    taskExecutor: TaskExecutor,
    searchRequestService: SearchRequestService
  ) {
    super();
    this.redis = new Redis(redisUrl);
    this.deviceManager = deviceManager;
    this.taskExecutor = taskExecutor;
    this.searchRequestService = searchRequestService;
  }

  /**
   * 검색 요청 전송 함수 설정
   */
  setSearchRequestSender(sender: (requestId: string, searchInput: { keyword: string; title: string; url: string }, deviceIds: string[]) => Promise<any>): void {
    this.searchRequestSender = sender;
  }

  /**
   * 스케줄러 시작
   */
  start(): void {
    if (this.isRunning) {
      console.log('스케줄러가 이미 실행 중입니다');
      return;
    }

    this.isRunning = true;
    console.log('=== 버퍼 스케줄러 시작 ===');
    this.runLoop();
  }

  /**
   * 스케줄러 중지
   */
  stop(): void {
    this.isRunning = false;
    console.log('=== 버퍼 스케줄러 중지 ===');
  }

  /**
   * 메인 실행 루프
   */
  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        // 다음 작업 결정
        const nextJob = await this.determineNextJob();
        
        if (nextJob) {
          await this.executeJob(nextJob);
        } else {
          // 사용 가능한 기기가 없으면 대기
          console.log('사용 가능한 기기 없음, 대기 중...');
        }

        // 다음 작업까지 대기
        await this.sleep(this.jobInterval);

      } catch (error) {
        console.error('스케줄러 루프 오류:', error);
        await this.sleep(5000);
      }
    }
  }

  /**
   * 다음 작업 결정
   * 
   * 로직:
   * 1. 검색 요청이 있으면: 요청 → 자동화 → 요청 → 자동화 번갈아 실행
   * 2. 검색 요청이 없으면: 자동화만 로테이션
   */
  private async determineNextJob(): Promise<ScheduledJob | null> {
    // 사용 가능한 기기 확인
    const availableDevices = await this.deviceManager.getAvailableDevices();
    if (availableDevices.length === 0) {
      return null;
    }

    // 대기 중인 검색 요청 확인
    const pendingRequest = await this.searchRequestService.getNextPendingRequest();
    const pendingCount = await this.searchRequestService.getPendingCount();

    // 검색 요청이 있는 경우: 요청과 자동화 번갈아 실행
    if (pendingRequest && pendingCount > 0) {
      // 마지막 작업이 자동화였으면 검색 요청 실행
      // 마지막 작업이 검색 요청이었으면 자동화 실행
      const lastJobType = this.currentJob?.type;
      
      if (lastJobType === 'automation' || lastJobType === undefined) {
        // 검색 요청 실행
        return this.createSearchJob(pendingRequest, availableDevices);
      } else {
        // 자동화 실행 (버퍼 역할)
        return this.createAutomationJob(availableDevices);
      }
    }

    // 검색 요청이 없는 경우: 자동화만 실행
    return this.createAutomationJob(availableDevices);
  }

  /**
   * 자동화 작업 생성
   */
  private createAutomationJob(devices: Device[]): ScheduledJob {
    const commandType = this.automationCommands[this.automationIndex];
    
    // 로테이션 인덱스 업데이트
    this.automationIndex = (this.automationIndex + 1) % this.automationCommands.length;

    return {
      id: `job_auto_${Date.now()}`,
      type: 'automation',
      commandType,
      status: 'pending',
      assignedDevices: devices.map(d => d.id)
    };
  }

  /**
   * 검색 요청 작업 생성
   */
  private createSearchJob(request: SearchRequest, devices: Device[]): ScheduledJob {
    return {
      id: `job_search_${request.id}`,
      type: 'search_request',
      searchRequest: request,
      status: 'pending',
      assignedDevices: devices.map(d => d.id)
    };
  }

  /**
   * 작업 실행
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    this.currentJob = job;
    job.status = 'running';
    job.startedAt = new Date();

    console.log(`\n>>> 작업 시작: ${job.type} (${job.id})`);
    console.log(`    할당된 기기: ${job.assignedDevices.length}대`);

    try {
      if (job.type === 'automation') {
        // 자동화 작업 실행
        await this.executeAutomationJob(job);
      } else if (job.type === 'search_request') {
        // 검색 요청 실행
        await this.executeSearchJob(job);
      }

      job.status = 'completed';
      job.completedAt = new Date();
      this.totalJobsCompleted++;

      console.log(`<<< 작업 완료: ${job.id}`);

    } catch (error) {
      job.status = 'failed';
      job.completedAt = new Date();
      console.error(`!!! 작업 실패: ${job.id}`, error);
    }

    this.emit('jobCompleted', job);
  }

  /**
   * 자동화 작업 실행
   */
  private async executeAutomationJob(job: ScheduledJob): Promise<void> {
    if (!job.commandType) return;

    console.log(`    자동화 커맨드: ${job.commandType}`);

    // TaskExecutor를 통해 실행
    const task = await this.taskExecutor.createTask(job.commandType, job.assignedDevices.length);
    await this.taskExecutor.executeTask(task.id);
  }

  /**
   * 검색 요청 실행
   */
  private async executeSearchJob(job: ScheduledJob): Promise<void> {
    if (!job.searchRequest) return;

    const request = job.searchRequest;
    console.log(`    검색 요청: ${request.keyword} / ${request.title}`);
    console.log(`    현재 단계: ${request.currentPhase}`);

    // 처리 시작 표시
    await this.searchRequestService.startProcessing(request.id, job.assignedDevices);

    // 워커에 검색 명령 전송
    if (this.searchRequestSender) {
      await this.searchRequestSender(request.id, {
        keyword: request.keyword,
        title: request.title,
        url: request.url
      }, job.assignedDevices);
      
      // 결과는 WebSocket을 통해 비동기로 수신됨
      // simulateSearchExecution은 제거하고 실제 결과 대기
      console.log(`검색 요청 전송 완료: ${request.id}`);
      return;
    }

    // 폴백: 시뮬레이션 (워커 연결이 없을 때)
    const results = await this.simulateSearchExecution(request, job.assignedDevices);

    // 결과 처리
    for (const result of results) {
      await this.searchRequestService.updateResult(result);
      
      // 찾았으면 바로 완료
      if (result.found) {
        this.totalSearchRequestsCompleted++;
        return;
      }
    }

    // 모든 단계 실패 시 처리
    const updatedRequest = await this.searchRequestService.getRequest(request.id);
    if (updatedRequest && updatedRequest.status === 'not_found') {
      this.totalSearchRequestsCompleted++;
    }
  }

  /**
   * 검색 실행 시뮬레이션 (실제 구현 시 워커 통신으로 대체)
   */
  private async simulateSearchExecution(
    request: SearchRequest, 
    deviceIds: string[]
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    for (const deviceId of deviceIds) {
      // 시뮬레이션: 랜덤하게 성공/실패
      const found = Math.random() > 0.7;
      
      results.push({
        requestId: request.id,
        deviceId,
        phase: request.currentPhase,
        found,
        durationMs: Math.floor(Math.random() * 5000) + 2000
      });

      // 찾았으면 바로 반환
      if (found) {
        return results;
      }
    }

    return results;
  }

  /**
   * 스케줄러 상태 조회
   */
  async getStatus(): Promise<SchedulerStatus> {
    const pendingCount = await this.searchRequestService.getPendingCount();

    return {
      isRunning: this.isRunning,
      currentJob: this.currentJob,
      pendingSearchRequests: pendingCount,
      automationRotationIndex: this.automationIndex,
      totalJobsCompleted: this.totalJobsCompleted,
      totalSearchRequestsCompleted: this.totalSearchRequestsCompleted
    };
  }

  /**
   * 작업 간격 설정
   */
  setJobInterval(ms: number): void {
    this.jobInterval = ms;
    console.log(`작업 간격 설정: ${ms}ms`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async close(): Promise<void> {
    this.stop();
    await this.redis.quit();
  }
}

