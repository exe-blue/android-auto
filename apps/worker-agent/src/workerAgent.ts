/**
 * 워커 에이전트
 * 제어서버와 통신하며 로컬 기기들의 명령 실행 관리
 */

import WebSocket from 'ws';
import { AdbController, AdbDevice } from './adbController';
import { CommandExecutor, CommandType, ExecutionResult } from './commandExecutor';

// 설정 인터페이스
export interface WorkerConfig {
  workerId: number;
  controlServerUrl: string;
  wifiSubnet: string;        // 192.168.1 또는 192.168.2
  maxConcurrent: number;     // 동시 실행 수
  heartbeatInterval: number; // 헬스체크 주기 (ms)
  adbPort: number;           // 기본 5555
}

// 제어서버 메시지 타입
interface ServerMessage {
  type: 'execute' | 'status' | 'ping' | 'register';
  taskId?: string;
  commandType?: CommandType;
  devices?: string[];
  data?: unknown;
}

// 응답 메시지 타입
interface WorkerResponse {
  type: 'result' | 'status' | 'pong' | 'registered' | 'heartbeat';
  workerId: number;
  taskId?: string;
  results?: ExecutionResult[];
  devices?: AdbDevice[];
  stats?: WorkerStats;
}

// 워커 통계
interface WorkerStats {
  totalDevices: number;
  onlineDevices: number;
  busyDevices: number;
  completedTasks: number;
  failedTasks: number;
}

export class WorkerAgent {
  private config: WorkerConfig;
  private adb: AdbController;
  private executor: CommandExecutor;
  private ws: WebSocket | null = null;
  private devices: Map<string, AdbDevice> = new Map();
  private busyDevices: Set<string> = new Set();
  private stats: WorkerStats;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.adb = new AdbController();
    this.executor = new CommandExecutor(this.adb);
    this.stats = {
      totalDevices: 0,
      onlineDevices: 0,
      busyDevices: 0,
      completedTasks: 0,
      failedTasks: 0
    };
  }

  /**
   * 에이전트 시작
   */
  async start(): Promise<void> {
    console.log(`=================================`);
    console.log(`  워커 에이전트 #${this.config.workerId}`);
    console.log(`  서브넷: ${this.config.wifiSubnet}.0/24`);
    console.log(`  최대 동시 실행: ${this.config.maxConcurrent}`);
    console.log(`=================================`);

    // ADB 서버 시작
    await this.adb.startServer();

    // 기기 스캔
    await this.scanDevices();

    // 제어서버 연결
    this.connectToServer();

    // 주기적 기기 스캔
    setInterval(() => this.scanDevices(), 30000);

    // 주기적 헬스체크
    setInterval(() => this.sendHeartbeat(), this.config.heartbeatInterval);
  }

  /**
   * WiFi 네트워크의 기기 스캔
   */
  async scanDevices(): Promise<void> {
    console.log('기기 스캔 시작...');
    
    // 기존 연결된 기기 목록
    const existingDevices = await this.adb.getDevices();
    
    // IP 범위 스캔 (192.168.x.10 ~ 192.168.x.200)
    const subnet = this.config.wifiSubnet;
    const scanPromises: Promise<boolean>[] = [];

    for (let i = 10; i <= 200; i++) {
      const ip = `${subnet}.${i}`;
      // 이미 연결된 기기는 스킵
      const serial = `${ip}:${this.config.adbPort}`;
      if (!existingDevices.some(d => d.serial === serial)) {
        scanPromises.push(this.adb.connectDevice(ip, this.config.adbPort));
      }
    }

    // 병렬 연결 시도 (한 번에 20개씩)
    for (let i = 0; i < scanPromises.length; i += 20) {
      const batch = scanPromises.slice(i, i + 20);
      await Promise.all(batch);
    }

    // 연결된 기기 업데이트
    const devices = await this.adb.getDevices();
    this.devices.clear();
    
    for (const device of devices) {
      if (device.status === 'device' && device.serial.startsWith(subnet)) {
        this.devices.set(device.serial, device);
      }
    }

    this.stats.totalDevices = this.devices.size;
    this.stats.onlineDevices = this.devices.size;
    
    console.log(`기기 스캔 완료: ${this.devices.size}대 연결됨`);
  }

  /**
   * 제어서버 WebSocket 연결
   */
  private connectToServer(): void {
    console.log(`제어서버 연결 중: ${this.config.controlServerUrl}`);

    this.ws = new WebSocket(this.config.controlServerUrl);

    this.ws.on('open', () => {
      console.log('제어서버 연결됨');
      this.register();
    });

    this.ws.on('message', (data: string) => {
      this.handleMessage(JSON.parse(data));
    });

    this.ws.on('close', () => {
      console.log('제어서버 연결 끊김, 재연결 시도...');
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket 오류:', error);
    });
  }

  /**
   * 재연결 스케줄
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.connectToServer();
    }, 5000);
  }

  /**
   * 워커 등록
   */
  private register(): void {
    this.send({
      type: 'registered',
      workerId: this.config.workerId,
      devices: Array.from(this.devices.values()),
      stats: this.stats
    });
  }

  /**
   * 헬스체크 전송
   */
  private sendHeartbeat(): void {
    this.stats.busyDevices = this.busyDevices.size;
    
    this.send({
      type: 'heartbeat',
      workerId: this.config.workerId,
      stats: this.stats,
      devices: Array.from(this.devices.values())
    });
  }

  /**
   * 메시지 처리
   */
  private async handleMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'ping':
        this.send({ type: 'pong', workerId: this.config.workerId });
        break;

      case 'status':
        this.send({
          type: 'status',
          workerId: this.config.workerId,
          stats: this.stats,
          devices: Array.from(this.devices.values())
        });
        break;

      case 'execute':
        if (message.taskId && message.commandType && message.devices) {
          await this.executeTask(
            message.taskId,
            message.commandType,
            message.devices
          );
        }
        break;

      default:
        console.log('알 수 없는 메시지:', message);
    }
  }

  /**
   * 작업 실행
   */
  private async executeTask(
    taskId: string,
    commandType: CommandType,
    deviceSerials: string[]
  ): Promise<void> {
    console.log(`작업 수신: ${taskId} (${commandType}, ${deviceSerials.length}대)`);

    const results: ExecutionResult[] = [];
    
    // 동시 실행 제한을 위한 세마포어
    const semaphore = new Semaphore(this.config.maxConcurrent);

    const executePromises = deviceSerials.map(async (serial) => {
      await semaphore.acquire();
      
      try {
        this.busyDevices.add(serial);
        const result = await this.executor.executeWithRetry(serial, commandType);
        results.push(result);

        if (result.success) {
          this.stats.completedTasks++;
        } else {
          this.stats.failedTasks++;
        }
      } finally {
        this.busyDevices.delete(serial);
        semaphore.release();
      }
    });

    await Promise.all(executePromises);

    // 결과 전송
    this.send({
      type: 'result',
      workerId: this.config.workerId,
      taskId,
      results
    });

    console.log(`작업 완료: ${taskId} - 성공: ${results.filter(r => r.success).length}, 실패: ${results.filter(r => !r.success).length}`);
  }

  /**
   * 메시지 전송
   */
  private send(message: WorkerResponse): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 에이전트 종료
   */
  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.ws) {
      this.ws.close();
    }
    console.log('워커 에이전트 종료됨');
  }
}

/**
 * 세마포어 (동시 실행 제한)
 */
class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next();
    } else {
      this.permits++;
    }
  }
}

// 메인 실행
if (require.main === module) {
  const config: WorkerConfig = {
    workerId: parseInt(process.env.WORKER_ID || '1'),
    controlServerUrl: process.env.CONTROL_SERVER_URL || 'ws://localhost:3000/ws',
    wifiSubnet: process.env.WIFI_SUBNET || '192.168.1',
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '50'),
    heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '10000'),
    adbPort: parseInt(process.env.ADB_PORT || '5555')
  };

  const agent = new WorkerAgent(config);
  agent.start().catch(console.error);

  // 종료 처리
  process.on('SIGINT', async () => {
    console.log('\n종료 중...');
    await agent.stop();
    process.exit(0);
  });
}

