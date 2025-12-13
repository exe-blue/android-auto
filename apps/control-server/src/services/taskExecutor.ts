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

// 워커 요청 인터페이스
interface WorkerRequest {
  taskId: string;
  commandType: CommandType;
  devices: Device[];
}

export class TaskExecutor {
  private redis: Redis;
  private deviceManager: DeviceManager;
  private workerClients: Map<number, WebSocket> = new Map();
  
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

    if (worker1Devices.length > 0) {
      promises.push(this.sendToWorker(1, {
        taskId,
        commandType: task.commandType,
        devices: worker1Devices
      }));
    }

    if (worker2Devices.length > 0) {
      promises.push(this.sendToWorker(2, {
        taskId,
        commandType: task.commandType,
        devices: worker2Devices
      }));
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
  private async sendToWorker(workerId: number, request: WorkerRequest): Promise<ExecutionResult[]> {
    // 실제 구현에서는 WebSocket 또는 HTTP로 워커에 전송
    // 여기서는 시뮬레이션
    
    const results: ExecutionResult[] = [];
    
    for (const device of request.devices) {
      // 실제로는 워커가 ADB 명령 실행 후 결과 반환
      const startTime = Date.now();
      
      try {
        // TODO: 실제 워커 통신 구현
        // const response = await this.workerClients.get(workerId)?.send(request);
        
        results.push({
          taskId: request.taskId,
          deviceId: device.id,
          success: true,
          durationMs: Date.now() - startTime
        });
      } catch (error) {
        results.push({
          taskId: request.taskId,
          deviceId: device.id,
          success: false,
          durationMs: Date.now() - startTime,
          errorMessage: error instanceof Error ? error.message : '알 수 없는 오류'
        });
      }
    }
    
    return results;
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

