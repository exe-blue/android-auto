/**
 * 제어서버 API
 * VPN으로만 접근 가능한 관리 API
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { DeviceManager } from '../services/deviceManager';
import { TaskExecutor, CommandType } from '../services/taskExecutor';

const app = express();
app.use(cors());
app.use(express.json());

// 환경 변수
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const VPN_SUBNET = process.env.VPN_SUBNET || '10.0.0.0/24';
const PORT = process.env.PORT || 3000;

// 서비스 인스턴스
const deviceManager = new DeviceManager(REDIS_URL);
const taskExecutor = new TaskExecutor(REDIS_URL, deviceManager);

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

// 모든 API에 VPN 인증 적용
app.use('/api', vpnAuth);

/**
 * 헬스체크
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * 기기 통계 조회
 */
app.get('/api/devices/stats', async (req: Request, res: Response) => {
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
app.get('/api/devices/available', async (req: Request, res: Response) => {
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

/**
 * 새 작업 생성 및 실행
 */
app.post('/api/tasks/execute', async (req: Request, res: Response) => {
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
app.get('/api/tasks/:taskId', async (req: Request, res: Response) => {
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
app.get('/api/tasks', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const tasks = await taskExecutor.getRecentTasks(limit);
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: '작업 목록 조회 실패' });
  }
});

/**
 * 로테이션으로 다음 커맨드 실행
 */
app.post('/api/tasks/execute-next', async (req: Request, res: Response) => {
  try {
    const { targetCount } = req.body;
    
    // 다음 로테이션 커맨드로 작업 생성
    const task = await taskExecutor.createTask(undefined, targetCount);
    
    // 비동기 실행
    taskExecutor.executeTask(task.id).catch(err => {
      console.error(`작업 실행 오류: ${task.id}`, err);
    });
    
    res.json({
      message: '다음 로테이션 작업이 시작되었습니다',
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
 * 서버 시작
 */
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`  Android 자동화 제어서버`);
  console.log(`  포트: ${PORT}`);
  console.log(`  VPN 서브넷: ${VPN_SUBNET}`);
  console.log(`  Redis: ${REDIS_URL}`);
  console.log(`=================================`);
});

// 종료 처리
process.on('SIGINT', async () => {
  console.log('\n서버 종료 중...');
  await deviceManager.close();
  await taskExecutor.close();
  process.exit(0);
});

export default app;

