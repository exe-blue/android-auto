/**
 * 워커 에이전트
 * 제어서버와 통신하며 로컬 기기들의 명령 실행 관리
 */

import WebSocket from 'ws';
import { AdbController, AdbDevice } from './adbController';
import { CommandExecutor, CommandType, ExecutionResult } from './commandExecutor';
import { SearchCommand, SearchInput, SearchExecutionResult } from './searchCommand';

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
  type: 'execute' | 'execute_search' | 'status' | 'ping' | 'register';
  taskId?: string;
  requestId?: string;
  commandType?: CommandType;
  devices?: string[];
  deviceSerials?: string[];
  searchInput?: SearchInput;
  data?: unknown;
}

// 응답 메시지 타입
interface WorkerResponse {
  type: 'result' | 'search_result' | 'status' | 'pong' | 'registered' | 'heartbeat';
  workerId: number;
  taskId?: string;
  requestId?: string;
  results?: ExecutionResult[];
  result?: {
    requestId: string;
    deviceId: string;
    phase: string;
    found: boolean;
    durationMs: number;
    errorMessage?: string;
  };
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
  private searchCommand: SearchCommand | null = null;
  private ws: WebSocket | null = null;
  private devices: Map<string, AdbDevice> = new Map();
  private busyDevices: Set<string> = new Set();
  private stats: WorkerStats;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.adb = new AdbController();
    this.executor = new CommandExecutor(this.adb);
    
    // 검색 커맨드 초기화 (기본 설정, 시뮬레이션 모드)
    // 실제 앱 패키지명/좌표는 환경 변수나 설정 파일에서 로드
    const { defaultSearchConfig } = require('./searchCommand');
    // 시뮬레이션 모드는 환경 변수로 제어 (기기 없이 테스트 가능)
    const config = { ...defaultSearchConfig, simulationMode: process.env.SIMULATION_MODE === 'true' };
    this.searchCommand = new SearchCommand(this.adb, config);
    
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

      case 'execute_search':
        if (message.requestId && message.searchInput && message.deviceSerials) {
          await this.executeSearch(
            message.requestId,
            message.searchInput,
            message.deviceSerials
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
   * 검색 요청 실행
   */
  private async executeSearch(
    requestId: string,
    searchInput: SearchInput,
    deviceSerials: string[]
  ): Promise<void> {
    console.log(`검색 요청 수신: ${requestId} (${deviceSerials.length}대)`);

    if (!this.searchCommand) {
      console.warn('검색 커맨드가 초기화되지 않았습니다. 기본 설정으로 초기화합니다.');
      // 기본 검색 커맨드 생성 (시뮬레이션 모드)
      const { defaultSearchConfig } = await import('./searchCommand');
      this.searchCommand = new SearchCommand(this.adb, defaultSearchConfig);
    }

    // 각 기기에 대해 검색 실행
    for (const serial of deviceSerials) {
      // 기기가 사용 중이면 스킵
      if (this.busyDevices.has(serial)) {
        console.log(`기기 ${serial}가 사용 중입니다. 스킵합니다.`);
        continue;
      }

      this.busyDevices.add(serial);

      try {
        const result = await this.searchCommand.execute(serial, searchInput);
        
        // 결과 전송
        this.send({
          type: 'search_result',
          workerId: this.config.workerId,
          requestId,
          result: {
            requestId,
            deviceId: serial,
            phase: result.phase,
            found: result.found,
            durationMs: result.durationMs,
            errorMessage: result.errorMessage
          }
        });

        // 찾았으면 다른 기기는 실행하지 않음
        if (result.found) {
          console.log(`검색 성공: ${requestId} (기기: ${serial}, 단계: ${result.phase})`);
          break;
        }
      } catch (error) {
        console.error(`검색 실행 오류: ${requestId} (기기: ${serial})`, error);
        
        // 오류 결과 전송
        this.send({
          type: 'search_result',
          workerId: this.config.workerId,
          requestId,
          result: {
            requestId,
            deviceId: serial,
            phase: 'keyword',
            found: false,
            durationMs: 0,
            errorMessage: error instanceof Error ? error.message : '알 수 없는 오류'
          }
        });
      } finally {
        this.busyDevices.delete(serial);
      }
    }

    console.log(`검색 요청 처리 완료: ${requestId}`);
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

