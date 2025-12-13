/**
 * 기기 관리 서비스
 * 260대 스마트폰의 상태 관리 및 ADB 연결 관리
 */

import Redis from 'ioredis';

// 기기 상태 타입
export type DeviceStatus = 'idle' | 'busy' | 'error' | 'offline';

// 기기 정보 인터페이스
export interface Device {
  id: string;
  deviceId: string;        // ADB device ID
  workerId: number;        // 워커PC ID (1 또는 2)
  ipAddress: string;       // WiFi IP 주소
  phoneNumber?: string;    // 유심 전화번호
  status: DeviceStatus;
  lastSeen: Date;
  errorCount: number;
}

// 워커PC 정보
export interface Worker {
  id: number;
  hostname: string;
  ipAddress: string;
  port: number;
  deviceCount: number;
  status: 'online' | 'offline';
}

export class DeviceManager {
  private redis: Redis;
  private workers: Map<number, Worker> = new Map();
  
  // 워커당 최대 기기 수
  private static MAX_DEVICES_PER_WORKER = 130;
  
  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  /**
   * 워커PC 등록
   */
  async registerWorker(worker: Worker): Promise<void> {
    this.workers.set(worker.id, worker);
    await this.redis.hset('workers', worker.id.toString(), JSON.stringify(worker));
    console.log(`워커 등록: ${worker.hostname} (${worker.ipAddress})`);
  }

  /**
   * 기기 등록
   */
  async registerDevice(device: Omit<Device, 'status' | 'lastSeen' | 'errorCount'>): Promise<Device> {
    const fullDevice: Device = {
      ...device,
      status: 'idle',
      lastSeen: new Date(),
      errorCount: 0
    };
    
    await this.redis.hset('devices', device.id, JSON.stringify(fullDevice));
    console.log(`기기 등록: ${device.deviceId} (${device.ipAddress})`);
    
    return fullDevice;
  }

  /**
   * 기기 상태 업데이트
   */
  async updateDeviceStatus(deviceId: string, status: DeviceStatus): Promise<void> {
    const deviceJson = await this.redis.hget('devices', deviceId);
    if (!deviceJson) {
      throw new Error(`기기를 찾을 수 없음: ${deviceId}`);
    }
    
    const device: Device = JSON.parse(deviceJson);
    device.status = status;
    device.lastSeen = new Date();
    
    if (status === 'error') {
      device.errorCount++;
    } else if (status === 'idle') {
      device.errorCount = 0;
    }
    
    await this.redis.hset('devices', deviceId, JSON.stringify(device));
  }

  /**
   * 사용 가능한 기기 목록 조회
   */
  async getAvailableDevices(count?: number): Promise<Device[]> {
    const allDevices = await this.redis.hgetall('devices');
    const availableDevices: Device[] = [];
    
    for (const [_, deviceJson] of Object.entries(allDevices)) {
      const device: Device = JSON.parse(deviceJson);
      
      // idle 상태이고 최근 30초 이내 확인된 기기만 선택
      const lastSeenTime = new Date(device.lastSeen).getTime();
      const isRecent = Date.now() - lastSeenTime < 30000;
      
      if (device.status === 'idle' && isRecent) {
        availableDevices.push(device);
      }
    }
    
    // 요청된 수만큼만 반환
    if (count && count < availableDevices.length) {
      return availableDevices.slice(0, count);
    }
    
    return availableDevices;
  }

  /**
   * 워커별 기기 분배
   */
  async getDevicesByWorker(workerId: number): Promise<Device[]> {
    const allDevices = await this.redis.hgetall('devices');
    const workerDevices: Device[] = [];
    
    for (const [_, deviceJson] of Object.entries(allDevices)) {
      const device: Device = JSON.parse(deviceJson);
      if (device.workerId === workerId) {
        workerDevices.push(device);
      }
    }
    
    return workerDevices;
  }

  /**
   * 전체 기기 통계
   */
  async getStats(): Promise<{
    total: number;
    idle: number;
    busy: number;
    error: number;
    offline: number;
  }> {
    const allDevices = await this.redis.hgetall('devices');
    const stats = {
      total: 0,
      idle: 0,
      busy: 0,
      error: 0,
      offline: 0
    };
    
    for (const [_, deviceJson] of Object.entries(allDevices)) {
      const device: Device = JSON.parse(deviceJson);
      stats.total++;
      
      // 30초 이상 응답 없으면 오프라인 처리
      const lastSeenTime = new Date(device.lastSeen).getTime();
      if (Date.now() - lastSeenTime > 30000) {
        stats.offline++;
      } else {
        stats[device.status]++;
      }
    }
    
    return stats;
  }

  /**
   * 오프라인 기기 정리
   */
  async cleanupOfflineDevices(thresholdMs: number = 60000): Promise<string[]> {
    const allDevices = await this.redis.hgetall('devices');
    const removedIds: string[] = [];
    
    for (const [id, deviceJson] of Object.entries(allDevices)) {
      const device: Device = JSON.parse(deviceJson);
      const lastSeenTime = new Date(device.lastSeen).getTime();
      
      if (Date.now() - lastSeenTime > thresholdMs) {
        device.status = 'offline';
        await this.redis.hset('devices', id, JSON.stringify(device));
        removedIds.push(id);
      }
    }
    
    if (removedIds.length > 0) {
      console.log(`오프라인 처리된 기기: ${removedIds.length}대`);
    }
    
    return removedIds;
  }

  /**
   * 연결 종료
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

