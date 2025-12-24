/**
 * 작업 실행 서비스
 * 260대 동시 실행 및 작업 분배
 */

import Redis from 'ioredis';
import { DeviceManager, Device } from './deviceManager';

// 커맨드 타입
export enum CommandType {
  COMMAND_A = 'command_a',
  COMMAND_B = 'command_b', 
  COMMAND_C = 'command_c'
}

// 작업 상태
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

// 작업 정보
export interface Task {
  id: string;
  commandType: CommandType;
  status: TaskStatus;
  targetDeviceCount: number;
  completedCount: number;
  failedCount: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

// 실행 결과
export interface ExecutionResult {
  taskId: string;
  deviceId: string;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
  screenshotPath?: string;
}

// 워커 전송 함수 타입
export type WorkerSender = (workerId: number, message: any) => boolean;

// 작업 결과 대기 관리
interface PendingTask {
  taskId: string;
  expectedResults: number;
  receivedResults: ExecutionResult[];
  resolve: (results: ExecutionResult[]) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class TaskExecutor {
  private redis: Redis;
  private deviceManager: DeviceManager;
  private workerSender: WorkerSender | null = null;
  private pendingTasks: Map<string, PendingTask> = new Map();
  
  // 커맨드 로테이션
  private commandRotation: CommandType[] = [
    CommandType.COMMAND_A,
    CommandType.COMMAND_B,
    CommandType.COMMAND_C
  ];
  private currentCommandIndex = 0;

  constructor(redisUrl: string, deviceManager: DeviceManager) {
    this.redis = new Redis(redisUrl);
    this.deviceManager = deviceManager;
  }

  /**
   * 워커 전송 함수 설정
   */
  setWorkerSender(sender: WorkerSender): void {
    this.workerSender = sender;
  }

  /**
   * 작업 결과 처리 (WebSocket에서 호출)
   */
  async handleTaskResults(taskId: string, results: ExecutionResult[]): Promise<void> {
    const pending = this.pendingTasks.get(taskId);
    if (!pending) {
      console.warn(`작업 결과를 받았지만 대기 중인 작업이 없음: ${taskId}`);
      return;
    }

    pending.receivedResults.push(...results);

    if (pending.receivedResults.length >= pending.expectedResults) {
      clearTimeout(pending.timeout);
      this.pendingTasks.delete(taskId);
      pending.resolve(pending.receivedResults);
    }
  }

  /**
   * 다음 커맨드 가져오기 (로테이션)
   */
  getNextCommand(): CommandType {
    const command = this.commandRotation[this.currentCommandIndex];
    this.currentCommandIndex = (this.currentCommandIndex + 1) % this.commandRotation.length;
    return command;
  }

  /**
   * 작업 생성
   */
  async createTask(commandType?: CommandType, targetCount?: number): Promise<Task> {
    // 사용 가능한 기기 수 확인
    const availableDevices = await this.deviceManager.getAvailableDevices();
    const actualTargetCount = targetCount 
      ? Math.min(targetCount, availableDevices.length)
      : availableDevices.length;

    if (actualTargetCount === 0) {
      throw new Error('사용 가능한 기기가 없습니다');
    }

    const task: Task = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      commandType: commandType || this.getNextCommand(),
      status: 'pending',
      targetDeviceCount: actualTargetCount,
      completedCount: 0,
      failedCount: 0,
      createdAt: new Date()
    };

    await this.redis.hset('tasks', task.id, JSON.stringify(task));
    console.log(`작업 생성: ${task.id} (${task.commandType}, ${actualTargetCount}대)`);

    return task;
  }

  /**
   * 작업 실행
   */
  async executeTask(taskId: string): Promise<void> {
    const taskJson = await this.redis.hget('tasks', taskId);
    if (!taskJson) {
      throw new Error(`작업을 찾을 수 없음: ${taskId}`);
    }

    const task: Task = JSON.parse(taskJson);
    task.status = 'running';
    task.startedAt = new Date();
    await this.redis.hset('tasks', taskId, JSON.stringify(task));

    // 사용 가능한 기기 가져오기
    const devices = await this.deviceManager.getAvailableDevices(task.targetDeviceCount);
    
    // 기기 상태를 busy로 변경
    for (const device of devices) {
      await this.deviceManager.updateDeviceStatus(device.id, 'busy');
    }

    // 워커별로 기기 분배
    const worker1Devices = devices.filter(d => d.workerId === 1);
    const worker2Devices = devices.filter(d => d.workerId === 2);

    console.log(`작업 시작: ${taskId}`);
    console.log(`  - 워커1: ${worker1Devices.length}대`);
    console.log(`  - 워커2: ${worker2Devices.length}대`);

    // 병렬로 워커에 작업 전송
    const promises: Promise<ExecutionResult[]>[] = [];

    if (worker1Devices.length > 0 && this.workerSender) {
      promises.push(this.sendToWorker(1, {
        taskId,
        commandType: task.commandType,
        deviceSerials: worker1Devices.map(d => d.deviceId)
      }));
    }

    if (worker2Devices.length > 0 && this.workerSender) {
      promises.push(this.sendToWorker(2, {
        taskId,
        commandType: task.commandType,
        deviceSerials: worker2Devices.map(d => d.deviceId)
      }));
    }

    if (promises.length === 0) {
      throw new Error('연결된 워커가 없습니다');
    }

    // 모든 워커 결과 대기
    const results = await Promise.all(promises);
    const allResults = results.flat();

    // 결과 집계
    let completedCount = 0;
    let failedCount = 0;

    for (const result of allResults) {
      // 로그 저장
      await this.saveExecutionLog(result);

      if (result.success) {
        completedCount++;
        await this.deviceManager.updateDeviceStatus(result.deviceId, 'idle');
      } else {
        failedCount++;
        await this.deviceManager.updateDeviceStatus(result.deviceId, 'error');
      }
    }

    // 작업 완료 처리
    task.status = 'completed';
    task.completedCount = completedCount;
    task.failedCount = failedCount;
    task.completedAt = new Date();
    await this.redis.hset('tasks', taskId, JSON.stringify(task));

    console.log(`작업 완료: ${taskId}`);
    console.log(`  - 성공: ${completedCount}대`);
    console.log(`  - 실패: ${failedCount}대`);
  }

  /**
   * 워커에 작업 전송
   */
  private async sendToWorker(
    workerId: number, 
    request: { taskId: string; commandType: CommandType; deviceSerials: string[] }
  ): Promise<ExecutionResult[]> {
    if (!this.workerSender) {
      throw new Error('워커 전송 함수가 설정되지 않았습니다');
    }

    // 워커에 메시지 전송
    const sent = this.workerSender(workerId, {
      type: 'execute',
      taskId: request.taskId,
      commandType: request.commandType,
      devices: request.deviceSerials
    });

    if (!sent) {
      throw new Error(`워커 #${workerId}에 연결할 수 없습니다`);
    }

    // 결과 대기 (Promise)
    return new Promise<ExecutionResult[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(request.taskId);
        reject(new Error(`작업 타임아웃: ${request.taskId}`));
      }, 5 * 60 * 1000); // 5분 타임아웃

      this.pendingTasks.set(request.taskId, {
        taskId: request.taskId,
        expectedResults: request.deviceSerials.length,
        receivedResults: [],
        resolve,
        reject,
        timeout
      });
    });
  }

  /**
   * 실행 로그 저장
   */
  private async saveExecutionLog(result: ExecutionResult): Promise<void> {
    const logKey = `logs:${result.taskId}:${result.deviceId}`;
    await this.redis.set(logKey, JSON.stringify({
      ...result,
      timestamp: new Date()
    }));
    
    // 30일 후 자동 삭제
    await this.redis.expire(logKey, 30 * 24 * 60 * 60);
  }

  /**
   * 작업 상태 조회
   */
  async getTaskStatus(taskId: string): Promise<Task | null> {
    const taskJson = await this.redis.hget('tasks', taskId);
    if (!taskJson) return null;
    return JSON.parse(taskJson);
  }

  /**
   * 최근 작업 목록
   */
  async getRecentTasks(limit: number = 10): Promise<Task[]> {
    const allTasks = await this.redis.hgetall('tasks');
    const tasks: Task[] = Object.values(allTasks).map(json => JSON.parse(json));
    
    // 최신순 정렬
    tasks.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    return tasks.slice(0, limit);
  }

  /**
   * 연결 종료
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

