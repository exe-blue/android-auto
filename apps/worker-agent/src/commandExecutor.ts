/**
 * 커맨드 실행기
 * 3가지 자동화 커맨드 정의 및 실행
 */

import { AdbController, CommandResult } from './adbController';

// 커맨드 타입
export enum CommandType {
  COMMAND_A = 'command_a',
  COMMAND_B = 'command_b',
  COMMAND_C = 'command_c'
}

// 스텝 액션 타입
export type StepAction = 'tap' | 'swipe' | 'type' | 'wait' | 'keyevent' | 'start_app' | 'stop_app' | 'screenshot';

// 커맨드 스텝
export interface CommandStep {
  action: StepAction;
  description: string;
  // tap, swipe 좌표
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  // 텍스트 입력
  text?: string;
  // 키 이벤트
  keyCode?: number | string;
  // 앱 관련
  packageName?: string;
  activityName?: string;
  // 대기 시간 (ms)
  waitMs?: number;
  // 스와이프 지속 시간
  durationMs?: number;
}

// 커맨드 정의
export interface CommandDefinition {
  type: CommandType;
  name: string;
  description: string;
  steps: CommandStep[];
  timeoutMs: number;
  retryCount: number;
}

// 실행 결과
export interface ExecutionResult {
  success: boolean;
  commandType: CommandType;
  completedSteps: number;
  totalSteps: number;
  durationMs: number;
  errorMessage?: string;
  screenshotPath?: string;
}

export class CommandExecutor {
  private adb: AdbController;
  private commands: Map<CommandType, CommandDefinition> = new Map();

  constructor(adb: AdbController) {
    this.adb = adb;
    this.initializeCommands();
  }

  /**
   * 커맨드 정의 초기화
   * TODO: 실제 앱에 맞게 수정 필요
   */
  private initializeCommands(): void {
    // 커맨드 A: 예시 - 앱 실행 및 메인 화면 조작
    this.commands.set(CommandType.COMMAND_A, {
      type: CommandType.COMMAND_A,
      name: '커맨드 A',
      description: '앱 실행 후 메인 화면에서 작업 수행',
      timeoutMs: 60000,
      retryCount: 3,
      steps: [
        { action: 'start_app', packageName: 'com.example.app', description: '앱 실행' },
        { action: 'wait', waitMs: 3000, description: '앱 로딩 대기' },
        { action: 'tap', x: 540, y: 1200, description: '시작 버튼 탭' },
        { action: 'wait', waitMs: 2000, description: '화면 전환 대기' },
        { action: 'swipe', x: 540, y: 1500, endX: 540, endY: 500, durationMs: 300, description: '위로 스크롤' },
        { action: 'tap', x: 540, y: 800, description: '확인 버튼 탭' },
        { action: 'wait', waitMs: 1000, description: '완료 대기' }
      ]
    });

    // 커맨드 B: 예시 - 검색 및 상세 페이지
    this.commands.set(CommandType.COMMAND_B, {
      type: CommandType.COMMAND_B,
      name: '커맨드 B',
      description: '검색 후 상세 페이지 조회',
      timeoutMs: 90000,
      retryCount: 3,
      steps: [
        { action: 'start_app', packageName: 'com.example.app', description: '앱 실행' },
        { action: 'wait', waitMs: 3000, description: '앱 로딩 대기' },
        { action: 'tap', x: 540, y: 200, description: '검색창 탭' },
        { action: 'wait', waitMs: 500, description: '키보드 대기' },
        { action: 'type', text: '검색어', description: '검색어 입력' },
        { action: 'keyevent', keyCode: 66, description: '엔터 키' },
        { action: 'wait', waitMs: 3000, description: '검색 결과 대기' },
        { action: 'tap', x: 540, y: 600, description: '첫 번째 결과 탭' },
        { action: 'wait', waitMs: 2000, description: '상세 페이지 로딩' },
        { action: 'keyevent', keyCode: 4, description: '뒤로가기' }
      ]
    });

    // 커맨드 C: 예시 - 설정 변경
    this.commands.set(CommandType.COMMAND_C, {
      type: CommandType.COMMAND_C,
      name: '커맨드 C',
      description: '설정 페이지에서 토글 변경',
      timeoutMs: 45000,
      retryCount: 3,
      steps: [
        { action: 'start_app', packageName: 'com.example.app', description: '앱 실행' },
        { action: 'wait', waitMs: 3000, description: '앱 로딩 대기' },
        { action: 'tap', x: 980, y: 150, description: '메뉴 버튼 탭' },
        { action: 'wait', waitMs: 1000, description: '메뉴 열림 대기' },
        { action: 'tap', x: 800, y: 400, description: '설정 메뉴 탭' },
        { action: 'wait', waitMs: 2000, description: '설정 페이지 로딩' },
        { action: 'tap', x: 900, y: 500, description: '토글 스위치 탭' },
        { action: 'wait', waitMs: 1000, description: '변경 적용 대기' },
        { action: 'keyevent', keyCode: 4, description: '뒤로가기' },
        { action: 'keyevent', keyCode: 4, description: '뒤로가기' }
      ]
    });
  }

  /**
   * 커맨드 실행
   */
  async execute(serial: string, commandType: CommandType): Promise<ExecutionResult> {
    const command = this.commands.get(commandType);
    if (!command) {
      return {
        success: false,
        commandType,
        completedSteps: 0,
        totalSteps: 0,
        durationMs: 0,
        errorMessage: `알 수 없는 커맨드: ${commandType}`
      };
    }

    console.log(`[${serial}] 커맨드 실행 시작: ${command.name}`);
    const startTime = Date.now();
    let completedSteps = 0;
    let lastError: string | undefined;

    try {
      // 화면 켜기
      await this.adb.wakeUp(serial);
      await this.sleep(500);

      // 각 스텝 실행
      for (const step of command.steps) {
        const result = await this.executeStep(serial, step);
        
        if (!result.success) {
          lastError = result.error || `스텝 실패: ${step.description}`;
          console.log(`[${serial}] 스텝 실패: ${step.description} - ${lastError}`);
          break;
        }

        completedSteps++;
        console.log(`[${serial}] 스텝 완료 (${completedSteps}/${command.steps.length}): ${step.description}`);
      }

      const success = completedSteps === command.steps.length;
      const result: ExecutionResult = {
        success,
        commandType,
        completedSteps,
        totalSteps: command.steps.length,
        durationMs: Date.now() - startTime,
        errorMessage: success ? undefined : lastError
      };

      // 실패 시 스크린샷
      if (!success) {
        result.screenshotPath = await this.adb.takeScreenshot(serial) || undefined;
      }

      console.log(`[${serial}] 커맨드 완료: ${success ? '성공' : '실패'}`);
      return result;

    } catch (error) {
      const screenshotPath = await this.adb.takeScreenshot(serial);
      
      return {
        success: false,
        commandType,
        completedSteps,
        totalSteps: command.steps.length,
        durationMs: Date.now() - startTime,
        errorMessage: error instanceof Error ? error.message : '알 수 없는 오류',
        screenshotPath: screenshotPath || undefined
      };
    }
  }

  /**
   * 개별 스텝 실행
   */
  private async executeStep(serial: string, step: CommandStep): Promise<CommandResult> {
    switch (step.action) {
      case 'tap':
        if (step.x === undefined || step.y === undefined) {
          return { success: false, error: '좌표 필요', durationMs: 0 };
        }
        return this.adb.tap(serial, step.x, step.y);

      case 'swipe':
        if (step.x === undefined || step.y === undefined ||
            step.endX === undefined || step.endY === undefined) {
          return { success: false, error: '좌표 필요', durationMs: 0 };
        }
        return this.adb.swipe(serial, step.x, step.y, step.endX, step.endY, step.durationMs);

      case 'type':
        if (!step.text) {
          return { success: false, error: '텍스트 필요', durationMs: 0 };
        }
        return this.adb.inputText(serial, step.text);

      case 'keyevent':
        if (step.keyCode === undefined) {
          return { success: false, error: '키코드 필요', durationMs: 0 };
        }
        return this.adb.keyEvent(serial, step.keyCode);

      case 'start_app':
        if (!step.packageName) {
          return { success: false, error: '패키지명 필요', durationMs: 0 };
        }
        return this.adb.startApp(serial, step.packageName, step.activityName);

      case 'stop_app':
        if (!step.packageName) {
          return { success: false, error: '패키지명 필요', durationMs: 0 };
        }
        return this.adb.stopApp(serial, step.packageName);

      case 'wait':
        await this.sleep(step.waitMs || 1000);
        return { success: true, durationMs: step.waitMs || 1000 };

      case 'screenshot':
        const path = await this.adb.takeScreenshot(serial);
        return { success: !!path, output: path || undefined, durationMs: 0 };

      default:
        return { success: false, error: `알 수 없는 액션: ${step.action}`, durationMs: 0 };
    }
  }

  /**
   * 재시도 포함 실행
   */
  async executeWithRetry(serial: string, commandType: CommandType): Promise<ExecutionResult> {
    const command = this.commands.get(commandType);
    const retryCount = command?.retryCount || 3;

    let lastResult: ExecutionResult | null = null;

    for (let attempt = 1; attempt <= retryCount; attempt++) {
      console.log(`[${serial}] 실행 시도 ${attempt}/${retryCount}`);
      
      lastResult = await this.execute(serial, commandType);
      
      if (lastResult.success) {
        return lastResult;
      }

      // 실패 시 앱 재시작 후 재시도
      if (attempt < retryCount) {
        console.log(`[${serial}] 앱 재시작 후 재시도...`);
        const packageName = command?.steps.find(s => s.packageName)?.packageName;
        if (packageName) {
          await this.adb.restartApp(serial, packageName);
          await this.sleep(3000);
        }
      }
    }

    return lastResult!;
  }

  /**
   * 커맨드 정의 조회
   */
  getCommandDefinition(type: CommandType): CommandDefinition | undefined {
    return this.commands.get(type);
  }

  /**
   * 모든 커맨드 목록
   */
  getAllCommands(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  /**
   * 커맨드 정의 업데이트
   */
  updateCommand(definition: CommandDefinition): void {
    this.commands.set(definition.type, definition);
    console.log(`커맨드 업데이트됨: ${definition.name}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

