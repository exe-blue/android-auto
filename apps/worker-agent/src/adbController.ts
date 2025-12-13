/**
 * ADB 컨트롤러
 * 스마트폰 연결, 명령 실행, 스크린샷, 오류 복구
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// ADB 기기 정보
export interface AdbDevice {
  serial: string;        // IP:PORT 또는 USB serial
  status: 'device' | 'offline' | 'unauthorized';
  model?: string;
  product?: string;
}

// 명령 실행 결과
export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export class AdbController {
  private adbPath: string;
  private screenshotDir: string;

  constructor(adbPath: string = 'adb', screenshotDir: string = './screenshots') {
    this.adbPath = adbPath;
    this.screenshotDir = screenshotDir;
    
    // 스크린샷 디렉토리 생성
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
  }

  /**
   * ADB 서버 시작
   */
  async startServer(): Promise<void> {
    try {
      await execAsync(`${this.adbPath} start-server`);
      console.log('ADB 서버 시작됨');
    } catch (error) {
      console.error('ADB 서버 시작 실패:', error);
      throw error;
    }
  }

  /**
   * WiFi로 기기 연결
   */
  async connectDevice(ip: string, port: number = 5555): Promise<boolean> {
    const serial = `${ip}:${port}`;
    
    try {
      const { stdout } = await execAsync(`${this.adbPath} connect ${serial}`);
      const success = stdout.includes('connected') || stdout.includes('already connected');
      
      if (success) {
        console.log(`기기 연결됨: ${serial}`);
      } else {
        console.log(`기기 연결 실패: ${serial} - ${stdout}`);
      }
      
      return success;
    } catch (error) {
      console.error(`기기 연결 오류: ${serial}`, error);
      return false;
    }
  }

  /**
   * 기기 연결 해제
   */
  async disconnectDevice(serial: string): Promise<void> {
    try {
      await execAsync(`${this.adbPath} disconnect ${serial}`);
      console.log(`기기 연결 해제: ${serial}`);
    } catch (error) {
      console.error(`연결 해제 오류: ${serial}`, error);
    }
  }

  /**
   * 연결된 기기 목록 조회
   */
  async getDevices(): Promise<AdbDevice[]> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} devices -l`);
      const lines = stdout.split('\n').slice(1); // 첫 줄 "List of devices attached" 제외
      const devices: AdbDevice[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const device: AdbDevice = {
            serial: parts[0],
            status: parts[1] as 'device' | 'offline' | 'unauthorized'
          };

          // 추가 정보 파싱
          for (const part of parts.slice(2)) {
            if (part.startsWith('model:')) {
              device.model = part.split(':')[1];
            } else if (part.startsWith('product:')) {
              device.product = part.split(':')[1];
            }
          }

          devices.push(device);
        }
      }

      return devices;
    } catch (error) {
      console.error('기기 목록 조회 오류:', error);
      return [];
    }
  }

  /**
   * 셸 명령 실행
   */
  async shellCommand(serial: string, command: string, timeoutMs: number = 30000): Promise<CommandResult> {
    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execAsync(
        `${this.adbPath} -s ${serial} shell ${command}`,
        { timeout: timeoutMs }
      );

      return {
        success: true,
        output: stdout.trim(),
        error: stderr.trim() || undefined,
        durationMs: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
        durationMs: Date.now() - startTime
      };
    }
  }

  /**
   * 화면 탭
   */
  async tap(serial: string, x: number, y: number): Promise<CommandResult> {
    return this.shellCommand(serial, `input tap ${x} ${y}`);
  }

  /**
   * 스와이프
   */
  async swipe(
    serial: string,
    startX: number, startY: number,
    endX: number, endY: number,
    durationMs: number = 300
  ): Promise<CommandResult> {
    return this.shellCommand(
      serial,
      `input swipe ${startX} ${startY} ${endX} ${endY} ${durationMs}`
    );
  }

  /**
   * 텍스트 입력
   */
  async inputText(serial: string, text: string): Promise<CommandResult> {
    // 공백과 특수문자 이스케이프
    const escapedText = text.replace(/ /g, '%s').replace(/'/g, "\\'");
    return this.shellCommand(serial, `input text '${escapedText}'`);
  }

  /**
   * 키 이벤트 전송
   */
  async keyEvent(serial: string, keyCode: number | string): Promise<CommandResult> {
    return this.shellCommand(serial, `input keyevent ${keyCode}`);
  }

  /**
   * 홈 버튼
   */
  async pressHome(serial: string): Promise<CommandResult> {
    return this.keyEvent(serial, 'KEYCODE_HOME');
  }

  /**
   * 뒤로가기 버튼
   */
  async pressBack(serial: string): Promise<CommandResult> {
    return this.keyEvent(serial, 'KEYCODE_BACK');
  }

  /**
   * 앱 실행
   */
  async startApp(serial: string, packageName: string, activityName?: string): Promise<CommandResult> {
    if (activityName) {
      return this.shellCommand(
        serial,
        `am start -n ${packageName}/${activityName}`
      );
    }
    return this.shellCommand(
      serial,
      `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`
    );
  }

  /**
   * 앱 종료
   */
  async stopApp(serial: string, packageName: string): Promise<CommandResult> {
    return this.shellCommand(serial, `am force-stop ${packageName}`);
  }

  /**
   * 앱 재시작
   */
  async restartApp(serial: string, packageName: string, activityName?: string): Promise<CommandResult> {
    await this.stopApp(serial, packageName);
    await this.sleep(1000);
    return this.startApp(serial, packageName, activityName);
  }

  /**
   * 스크린샷 캡처
   */
  async takeScreenshot(serial: string, filename?: string): Promise<string | null> {
    const timestamp = Date.now();
    const safeSerial = serial.replace(/[:.]/g, '_');
    const screenshotName = filename || `screenshot_${safeSerial}_${timestamp}.png`;
    const remotePath = `/sdcard/${screenshotName}`;
    const localPath = path.join(this.screenshotDir, screenshotName);

    try {
      // 스크린샷 캡처
      await execAsync(`${this.adbPath} -s ${serial} shell screencap -p ${remotePath}`);
      
      // 로컬로 복사
      await execAsync(`${this.adbPath} -s ${serial} pull ${remotePath} ${localPath}`);
      
      // 원격 파일 삭제
      await execAsync(`${this.adbPath} -s ${serial} shell rm ${remotePath}`);

      console.log(`스크린샷 저장됨: ${localPath}`);
      return localPath;
    } catch (error) {
      console.error(`스크린샷 실패: ${serial}`, error);
      return null;
    }
  }

  /**
   * 기기 재부팅
   */
  async reboot(serial: string): Promise<CommandResult> {
    return this.shellCommand(serial, 'reboot');
  }

  /**
   * 화면 켜기
   */
  async wakeUp(serial: string): Promise<CommandResult> {
    return this.keyEvent(serial, 'KEYCODE_WAKEUP');
  }

  /**
   * 화면 잠금 해제 (스와이프)
   */
  async unlockScreen(serial: string): Promise<CommandResult> {
    // 기본 스와이프 잠금 해제 (아래에서 위로)
    return this.swipe(serial, 540, 1800, 540, 500, 300);
  }

  /**
   * 현재 액티비티 정보
   */
  async getCurrentActivity(serial: string): Promise<string | null> {
    const result = await this.shellCommand(
      serial,
      "dumpsys activity activities | grep mResumedActivity"
    );
    
    if (result.success && result.output) {
      // 패키지명/액티비티명 추출
      const match = result.output.match(/u0\s+([^\s]+)/);
      return match ? match[1] : null;
    }
    return null;
  }

  /**
   * 기기 정보 조회
   */
  async getDeviceInfo(serial: string): Promise<Record<string, string>> {
    const info: Record<string, string> = {};
    
    const props = [
      ['ro.product.model', 'model'],
      ['ro.product.brand', 'brand'],
      ['ro.build.version.release', 'androidVersion'],
      ['ro.build.version.sdk', 'sdkVersion']
    ];

    for (const [prop, key] of props) {
      const result = await this.shellCommand(serial, `getprop ${prop}`);
      if (result.success && result.output) {
        info[key] = result.output;
      }
    }

    return info;
  }

  /**
   * ADB over WiFi 활성화
   */
  async enableTcpIp(serial: string, port: number = 5555): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} tcpip ${port}`);
      console.log(`TCP/IP 활성화: ${serial} -> ${port}`);
      return true;
    } catch (error) {
      console.error(`TCP/IP 활성화 실패: ${serial}`, error);
      return false;
    }
  }

  /**
   * 유틸: 대기
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 기본 키코드 상수
export const KeyCodes = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  END_CALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  CLEAR: 28,
  ENTER: 66,
  DELETE: 67,
  MENU: 82,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  MUTE: 91,
  APP_SWITCH: 187,
  WAKEUP: 224,
  SLEEP: 223
} as const;

