/**
 * 제어서버 API
 * VPN으로만 접근 가능한 관리 API
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { DeviceManager, Device } from '../services/deviceManager';
import { TaskExecutor, CommandType, ExecutionResult } from '../services/taskExecutor';
import { AuthService, TokenPayload } from '../services/authService';
import { SearchRequestService, SearchRequest } from '../services/searchRequestService';
import { BufferScheduler } from '../services/bufferScheduler';

const app = express();
const server = http.createServer(app);

// CORS 설정
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));

app.use(express.json());

// 환경 변수
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const VPN_SUBNET = process.env.VPN_SUBNET || '10.0.0.0/24';
const PORT = process.env.PORT || 3000;

// 서비스 인스턴스
const deviceManager = new DeviceManager(REDIS_URL);
const taskExecutor = new TaskExecutor(REDIS_URL, deviceManager);
const authService = new AuthService(REDIS_URL);
const searchRequestService = new SearchRequestService(REDIS_URL);
const scheduler = new BufferScheduler(REDIS_URL, deviceManager, taskExecutor, searchRequestService);

// WebSocket 서버
const wss = new WebSocketServer({ server, path: '/ws' });

// 워커 연결 관리
interface WorkerConnection {
  workerId: number;
  ws: WebSocket;
  lastHeartbeat: Date;
  devices: Device[];
}
const workerConnections = new Map<number, WorkerConnection>();

// WebSocket 연결 처리
wss.on('connection', (ws: WebSocket) => {
  console.log('WebSocket 연결됨');

  let workerId: number | null = null;

  ws.on('message', async (data: string) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'registered':
          // 워커 등록
          workerId = message.workerId;
          const devices: Device[] = (message.devices || []).map((d: any) => ({
            id: `device_${workerId}_${d.serial}`,
            deviceId: d.serial,
            workerId: workerId!,
            ipAddress: d.serial.split(':')[0],
            status: 'idle' as const,
            lastSeen: new Date(),
            errorCount: 0
          }));

          // 기기 등록
          for (const device of devices) {
            await deviceManager.registerDevice(device);
          }

          workerConnections.set(workerId, {
            workerId,
            ws,
            lastHeartbeat: new Date(),
            devices
          });

          console.log(`워커 #${workerId} 등록됨 (${devices.length}대)`);
          break;

        case 'heartbeat':
          // 헬스체크
          if (message.workerId) {
            const conn = workerConnections.get(message.workerId);
            if (conn) {
              conn.lastHeartbeat = new Date();
              // 기기 정보 업데이트
              if (message.devices) {
                conn.devices = (message.devices || []).map((d: any) => ({
                  id: `device_${message.workerId}_${d.serial}`,
                  deviceId: d.serial,
                  workerId: message.workerId,
                  ipAddress: d.serial.split(':')[0],
                  status: 'idle' as const,
                  lastSeen: new Date(),
                  errorCount: 0
                }));
              }
            }
          }
          break;

        case 'result':
          // 작업 결과 수신
          if (message.taskId && message.results) {
            await taskExecutor.handleTaskResults(message.taskId, message.results);
          }
          break;

        case 'search_result':
          // 검색 결과 수신
          if (message.requestId && message.result) {
            const result = {
              requestId: message.requestId,
              deviceId: message.result.deviceId,
              phase: message.result.phase as 'keyword' | 'title' | 'url',
              found: message.result.found,
              durationMs: message.result.durationMs || 0,
              errorMessage: message.result.errorMessage
            };
            
            await searchRequestService.updateResult(result);
            
            // 찾았으면 처리 완료
            if (result.found) {
              console.log(`검색 성공: ${message.requestId} (${result.phase} 단계, 기기: ${result.deviceId})`);
            }
          }
          break;

        case 'pong':
          // ping 응답
          break;

        default:
          console.log('알 수 없는 메시지:', message);
      }
    } catch (error) {
      console.error('WebSocket 메시지 처리 오류:', error);
    }
  });

  ws.on('close', () => {
    if (workerId !== null) {
      console.log(`워커 #${workerId} 연결 끊김`);
      workerConnections.delete(workerId);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket 오류:', error);
  });
});

// 워커에게 명령 전송 헬퍼 함수
function sendToWorker(workerId: number, message: any): boolean {
  const conn = workerConnections.get(workerId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// 검색 요청 전송 함수
async function sendSearchRequestToWorkers(
  requestId: string,
  searchInput: { keyword: string; title: string; url: string },
  deviceIds: string[]
): Promise<void> {
  const allDevices = await deviceManager.getAvailableDevices();
  
  // 워커별로 그룹화
  const workerGroups = new Map<number, string[]>();
  for (const deviceId of deviceIds) {
    const device = allDevices.find(d => d.id === deviceId);
    if (device) {
      if (!workerGroups.has(device.workerId)) {
        workerGroups.set(device.workerId, []);
      }
      workerGroups.get(device.workerId)!.push(device.deviceId);
    }
  }

  // 각 워커에 검색 요청 전송
  for (const [workerId, deviceSerials] of workerGroups) {
    const sent = sendToWorker(workerId, {
      type: 'execute_search',
      requestId,
      searchInput,
      deviceSerials
    });

    if (sent) {
      // 결과는 워커에서 'search_result' 메시지로 받음
      console.log(`검색 요청 전송: ${requestId} → 워커 #${workerId} (${deviceSerials.length}대)`);
    } else {
      console.warn(`워커 #${workerId}에 검색 요청 전송 실패: ${requestId}`);
    }
  }
}

// TaskExecutor에 워커 전송 함수 제공
taskExecutor.setWorkerSender(sendToWorker);

// BufferScheduler에 검색 요청 전송 함수 제공
scheduler.setSearchRequestSender(sendSearchRequestToWorkers);

// Request에 user 정보 추가
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * VPN 접근 검증 미들웨어
 */
const vpnAuth = (req: Request, res: Response, next: NextFunction): void => {
  const clientIp = req.ip || req.socket.remoteAddress || '';
  
  // 개발 환경에서는 스킵
  if (process.env.NODE_ENV === 'development') {
    return next();
  }
  
  // VPN 서브넷 검증 (10.0.0.x)
  if (!clientIp.startsWith('10.0.0.')) {
    res.status(403).json({ error: 'VPN 접근만 허용됩니다' });
    return;
  }
  
  next();
};

/**
 * JWT 인증 미들웨어
 */
const jwtAuth = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '인증 토큰이 필요합니다' });
    return;
  }

  const token = authHeader.substring(7);
  const payload = authService.verifyToken(token);

  if (!payload) {
    res.status(401).json({ error: '유효하지 않은 토큰입니다' });
    return;
  }

  req.user = payload;
  next();
};

// 정적 파일 서빙 (Web Awesome dist, admin-web)
const distPath = path.join(__dirname, '../../../dist');
const adminWebPath = path.join(__dirname, '../../admin-web');

app.use('/dist', express.static(distPath));
app.use(express.static(adminWebPath));

// 루트 경로에서 admin-web index.html 서빙
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(adminWebPath, 'index.html'));
});

// 모든 API에 VPN 인증 적용 (개발 환경에서는 스킵)
if (process.env.NODE_ENV !== 'development') {
  app.use('/api', vpnAuth);
}

// ============================================
// 인증 API
// ============================================

/**
 * 로그인
 */
app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요' });
      return;
    }

    const result = await authService.login(username, password);

    if (!result.success) {
      res.status(401).json({ error: result.error });
      return;
    }

    res.json({
      message: '로그인 성공',
      token: result.token,
      user: result.user
    });
  } catch (error) {
    res.status(500).json({ error: '로그인 실패' });
  }
});

/**
 * 사용자 정보 조회
 */
app.get('/api/auth/me', jwtAuth, async (req: Request, res: Response) => {
  res.json({ user: req.user });
});

/**
 * 비밀번호 변경
 */
app.post('/api/auth/change-password', jwtAuth, async (req: Request, res: Response) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const username = req.user?.username;

    if (!username || !oldPassword || !newPassword) {
      res.status(400).json({ error: '필수 정보가 누락되었습니다' });
      return;
    }

    const success = await authService.changePassword(username, oldPassword, newPassword);

    if (!success) {
      res.status(400).json({ error: '비밀번호 변경 실패' });
      return;
    }

    res.json({ message: '비밀번호가 변경되었습니다' });
  } catch (error) {
    res.status(500).json({ error: '비밀번호 변경 실패' });
  }
});

// ============================================
// 헬스체크
// ============================================

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// 기기 API
// ============================================

/**
 * 기기 통계 조회
 */
app.get('/api/devices/stats', jwtAuth, async (req: Request, res: Response) => {
  try {
    const stats = await deviceManager.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: '통계 조회 실패' });
  }
});

/**
 * 사용 가능한 기기 수 조회
 */
app.get('/api/devices/available', jwtAuth, async (req: Request, res: Response) => {
  try {
    const devices = await deviceManager.getAvailableDevices();
    res.json({
      count: devices.length,
      devices: devices.map(d => ({
        id: d.id,
        deviceId: d.deviceId,
        workerId: d.workerId,
        status: d.status
      }))
    });
  } catch (error) {
    res.status(500).json({ error: '기기 조회 실패' });
  }
});

// ============================================
// 검색 요청 API
// ============================================

/**
 * 검색 요청 생성
 * 
 * Body:
 * - keyword: 검색 키워드
 * - title: 콘텐츠 제목
 * - url: 외부 URL (폴백용)
 */
app.post('/api/search-requests', jwtAuth, async (req: Request, res: Response) => {
  try {
    const { keyword, title, url, priority } = req.body;

    // 필수 필드 검증
    if (!keyword || !title || !url) {
      res.status(400).json({ 
        error: '키워드, 제목, 주소를 모두 입력해주세요' 
      });
      return;
    }

    // URL 검증
    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: '올바른 URL 형식이 아닙니다' });
      return;
    }

    const request = await searchRequestService.createRequest({
      userId: req.user!.userId,
      keyword,
      title,
      url,
      priority
    });

    res.json({
      message: '검색 요청이 등록되었습니다',
      request: {
        id: request.id,
        keyword: request.keyword,
        title: request.title,
        url: request.url,
        status: request.status,
        createdAt: request.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: '검색 요청 생성 실패' });
  }
});

/**
 * 검색 요청 상태 조회
 */
app.get('/api/search-requests/:requestId', jwtAuth, async (req: Request, res: Response) => {
  try {
    const request = await searchRequestService.getRequest(req.params.requestId);
    
    if (!request) {
      res.status(404).json({ error: '요청을 찾을 수 없습니다' });
      return;
    }

    // 본인 요청만 조회 가능 (관리자는 모두 조회 가능)
    if (request.userId !== req.user?.userId && req.user?.role !== 'admin') {
      res.status(403).json({ error: '접근 권한이 없습니다' });
      return;
    }

    res.json(request);
  } catch (error) {
    res.status(500).json({ error: '요청 조회 실패' });
  }
});

/**
 * 내 검색 요청 목록
 */
app.get('/api/search-requests', jwtAuth, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const requests = await searchRequestService.getUserRequests(req.user!.userId, limit);
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: '목록 조회 실패' });
  }
});

/**
 * 대기 중인 요청 수
 */
app.get('/api/search-requests/pending/count', jwtAuth, async (req: Request, res: Response) => {
  try {
    const count = await searchRequestService.getPendingCount();
    res.json({ pendingCount: count });
  } catch (error) {
    res.status(500).json({ error: '조회 실패' });
  }
});

// ============================================
// 자동화 작업 API
// ============================================

/**
 * 새 작업 생성 및 실행
 */
app.post('/api/tasks/execute', jwtAuth, async (req: Request, res: Response) => {
  try {
    const { commandType, targetCount } = req.body;
    
    // 커맨드 타입 검증
    if (commandType && !Object.values(CommandType).includes(commandType)) {
      res.status(400).json({ error: '잘못된 커맨드 타입' });
      return;
    }
    
    // 작업 생성
    const task = await taskExecutor.createTask(commandType, targetCount);
    
    // 비동기로 실행 (즉시 응답)
    taskExecutor.executeTask(task.id).catch(err => {
      console.error(`작업 실행 오류: ${task.id}`, err);
    });
    
    res.json({
      message: '작업이 시작되었습니다',
      taskId: task.id,
      commandType: task.commandType,
      targetDeviceCount: task.targetDeviceCount
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '작업 생성 실패';
    res.status(500).json({ error: message });
  }
});

/**
 * 작업 상태 조회
 */
app.get('/api/tasks/:taskId', jwtAuth, async (req: Request, res: Response) => {
  try {
    const task = await taskExecutor.getTaskStatus(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: '작업을 찾을 수 없습니다' });
      return;
    }
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: '작업 조회 실패' });
  }
});

/**
 * 최근 작업 목록
 */
app.get('/api/tasks', jwtAuth, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const tasks = await taskExecutor.getRecentTasks(limit);
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: '작업 목록 조회 실패' });
  }
});

// ============================================
// 스케줄러 API
// ============================================

/**
 * 스케줄러 상태 조회
 */
app.get('/api/scheduler/status', jwtAuth, async (req: Request, res: Response) => {
  try {
    const status = await scheduler.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: '상태 조회 실패' });
  }
});

/**
 * 스케줄러 시작
 */
app.post('/api/scheduler/start', jwtAuth, async (req: Request, res: Response) => {
  try {
    // 관리자만 가능
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '관리자 권한이 필요합니다' });
      return;
    }

    scheduler.start();
    res.json({ message: '스케줄러가 시작되었습니다' });
  } catch (error) {
    res.status(500).json({ error: '스케줄러 시작 실패' });
  }
});

/**
 * 스케줄러 중지
 */
app.post('/api/scheduler/stop', jwtAuth, async (req: Request, res: Response) => {
  try {
    // 관리자만 가능
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '관리자 권한이 필요합니다' });
      return;
    }

    scheduler.stop();
    res.json({ message: '스케줄러가 중지되었습니다' });
  } catch (error) {
    res.status(500).json({ error: '스케줄러 중지 실패' });
  }
});

/**
 * 작업 간격 설정
 */
app.post('/api/scheduler/interval', jwtAuth, async (req: Request, res: Response) => {
  try {
    // 관리자만 가능
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '관리자 권한이 필요합니다' });
      return;
    }

    const { intervalMs } = req.body;
    if (!intervalMs || intervalMs < 1000) {
      res.status(400).json({ error: '최소 1000ms 이상이어야 합니다' });
      return;
    }

    scheduler.setJobInterval(intervalMs);
    res.json({ message: `작업 간격이 ${intervalMs}ms로 설정되었습니다` });
  } catch (error) {
    res.status(500).json({ error: '설정 실패' });
  }
});

// ============================================
// 서버 시작
// ============================================

server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`  Android 자동화 제어서버`);
  console.log(`  HTTP 포트: ${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  VPN 서브넷: ${VPN_SUBNET}`);
  console.log(`  Redis: ${REDIS_URL}`);
  console.log(`=================================`);
  console.log(`\n기본 관리자: admin / admin1234`);
  console.log(`로그인 후 비밀번호를 변경해주세요!\n`);
  console.log(`웹 대시보드: http://localhost:${PORT}\n`);
});

// 종료 처리
process.on('SIGINT', async () => {
  console.log('\n서버 종료 중...');
  await deviceManager.close();
  await taskExecutor.close();
  await authService.close();
  await searchRequestService.close();
  await scheduler.close();
  process.exit(0);
});

export default app;
