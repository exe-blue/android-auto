/**
 * 검색 커맨드
 * 키워드 → 제목 → URL 3단계 폴백 검색
 */

import { AdbController, CommandResult } from './adbController';

// 검색 단계
export type SearchPhase = 'keyword' | 'title' | 'url';

// 검색 설정
export interface SearchConfig {
  appPackage: string;         // 검색할 앱 패키지명
  appActivity?: string;       // 앱 시작 액티비티
  searchButtonCoords: { x: number; y: number };  // 검색 버튼 좌표
  searchInputCoords: { x: number; y: number };   // 검색 입력창 좌표
  resultAreaCoords: { x: number; y: number };    // 결과 영역 좌표
  timeFilterCoords?: { x: number; y: number };   // 1시간 필터 좌표 (선택)
  maxScrolls: number;         // 최대 스크롤 횟수
  scrollDelay: number;        // 스크롤 간 대기 시간 (ms)
}

// 검색 입력
export interface SearchInput {
  keyword: string;
  title: string;
  url: string;
}

// 검색 결과
export interface SearchExecutionResult {
  found: boolean;
  phase: SearchPhase;
  durationMs: number;
  screenshotPath?: string;
  errorMessage?: string;
}

export class SearchCommand {
  private adb: AdbController;
  private config: SearchConfig;

  constructor(adb: AdbController, config: SearchConfig) {
    this.adb = adb;
    this.config = config;
  }

  /**
   * 3단계 검색 실행
   * 1. 키워드 검색 (1시간 이내 필터)
   * 2. 제목 검색
   * 3. URL 직접 이동
   */
  async execute(serial: string, input: SearchInput): Promise<SearchExecutionResult> {
    const startTime = Date.now();

    try {
      // 화면 켜기 및 잠금 해제
      await this.adb.wakeUp(serial);
      await this.sleep(500);
      await this.adb.unlockScreen(serial);
      await this.sleep(500);

      // 1단계: 키워드 검색
      console.log(`[${serial}] 1단계: 키워드 검색 - "${input.keyword}"`);
      const keywordResult = await this.searchByKeyword(serial, input.keyword, input.title);
      
      if (keywordResult.found) {
        return {
          found: true,
          phase: 'keyword',
          durationMs: Date.now() - startTime
        };
      }

      // 2단계: 제목 검색
      console.log(`[${serial}] 2단계: 제목 검색 - "${input.title}"`);
      const titleResult = await this.searchByTitle(serial, input.title);
      
      if (titleResult.found) {
        return {
          found: true,
          phase: 'title',
          durationMs: Date.now() - startTime
        };
      }

      // 3단계: URL 직접 이동
      console.log(`[${serial}] 3단계: URL 이동 - "${input.url}"`);
      const urlResult = await this.navigateToUrl(serial, input.url);
      
      if (urlResult.found) {
        return {
          found: true,
          phase: 'url',
          durationMs: Date.now() - startTime
        };
      }

      // 모든 단계 실패
      const screenshotPath = await this.adb.takeScreenshot(serial);
      return {
        found: false,
        phase: 'url',
        durationMs: Date.now() - startTime,
        screenshotPath: screenshotPath || undefined
      };

    } catch (error) {
      const screenshotPath = await this.adb.takeScreenshot(serial);
      return {
        found: false,
        phase: 'keyword',
        durationMs: Date.now() - startTime,
        errorMessage: error instanceof Error ? error.message : '알 수 없는 오류',
        screenshotPath: screenshotPath || undefined
      };
    }
  }

  /**
   * 키워드 검색 (1시간 이내 필터)
   */
  private async searchByKeyword(
    serial: string, 
    keyword: string,
    targetTitle: string
  ): Promise<{ found: boolean }> {
    // 앱 실행
    await this.adb.startApp(serial, this.config.appPackage, this.config.appActivity);
    await this.sleep(3000);

    // 검색 버튼 탭
    await this.adb.tap(serial, this.config.searchButtonCoords.x, this.config.searchButtonCoords.y);
    await this.sleep(1000);

    // 검색어 입력
    await this.adb.tap(serial, this.config.searchInputCoords.x, this.config.searchInputCoords.y);
    await this.sleep(500);
    await this.adb.inputText(serial, keyword);
    await this.adb.keyEvent(serial, 66); // Enter
    await this.sleep(2000);

    // 1시간 필터 적용 (설정된 경우)
    if (this.config.timeFilterCoords) {
      await this.adb.tap(serial, this.config.timeFilterCoords.x, this.config.timeFilterCoords.y);
      await this.sleep(1000);
      // TODO: 1시간 옵션 선택 (앱마다 다름)
    }

    // 스크롤하며 제목 찾기
    const found = await this.scrollAndFind(serial, targetTitle);
    
    return { found };
  }

  /**
   * 제목 검색
   */
  private async searchByTitle(serial: string, title: string): Promise<{ found: boolean }> {
    // 앱 실행 (이미 실행 중이면 홈으로)
    await this.adb.pressHome(serial);
    await this.sleep(500);
    await this.adb.startApp(serial, this.config.appPackage, this.config.appActivity);
    await this.sleep(3000);

    // 검색 버튼 탭
    await this.adb.tap(serial, this.config.searchButtonCoords.x, this.config.searchButtonCoords.y);
    await this.sleep(1000);

    // 제목 입력
    await this.adb.tap(serial, this.config.searchInputCoords.x, this.config.searchInputCoords.y);
    await this.sleep(500);
    await this.adb.inputText(serial, title);
    await this.adb.keyEvent(serial, 66); // Enter
    await this.sleep(2000);

    // 스크롤하며 찾기
    const found = await this.scrollAndFind(serial, title);
    
    return { found };
  }

  /**
   * URL 직접 이동
   */
  private async navigateToUrl(serial: string, url: string): Promise<{ found: boolean }> {
    try {
      // 브라우저로 URL 열기
      await this.adb.shellCommand(
        serial,
        `am start -a android.intent.action.VIEW -d "${url}"`
      );
      await this.sleep(3000);

      // URL이 열렸는지 확인 (현재 액티비티 체크)
      const activity = await this.adb.getCurrentActivity(serial);
      
      // 브라우저 또는 앱이 열렸으면 성공으로 처리
      if (activity && (activity.includes('browser') || activity.includes(this.config.appPackage))) {
        // 페이지 로딩 대기
        await this.sleep(3000);
        
        // 특정 버튼 클릭 (앱으로 이동 버튼 등)
        await this.adb.tap(serial, this.config.resultAreaCoords.x, this.config.resultAreaCoords.y);
        await this.sleep(2000);
        
        return { found: true };
      }

      return { found: false };
    } catch (error) {
      console.error(`[${serial}] URL 이동 오류:`, error);
      return { found: false };
    }
  }

  /**
   * 스크롤하며 콘텐츠 찾기
   * 
   * TODO: 실제 구현에서는 UI Automator나 OCR을 사용하여
   *       화면에서 텍스트를 찾아야 함
   */
  private async scrollAndFind(serial: string, targetText: string): Promise<boolean> {
    for (let i = 0; i < this.config.maxScrolls; i++) {
      // 현재 화면에서 텍스트 찾기 시도
      // TODO: 실제 구현 필요
      // - UI Automator: findElement by text
      // - OCR: 화면 캡처 후 텍스트 인식
      
      // 시뮬레이션: 랜덤하게 찾음
      if (Math.random() > 0.8) {
        console.log(`[${serial}] 콘텐츠 발견: "${targetText}"`);
        
        // 해당 콘텐츠 탭
        await this.adb.tap(serial, this.config.resultAreaCoords.x, this.config.resultAreaCoords.y);
        await this.sleep(2000);
        
        return true;
      }

      // 아래로 스크롤
      await this.adb.swipe(serial, 540, 1500, 540, 500, 300);
      await this.sleep(this.config.scrollDelay);
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * 기본 검색 설정 (앱에 맞게 수정 필요)
 */
export const defaultSearchConfig: SearchConfig = {
  appPackage: 'com.example.app',
  searchButtonCoords: { x: 540, y: 150 },
  searchInputCoords: { x: 540, y: 200 },
  resultAreaCoords: { x: 540, y: 600 },
  timeFilterCoords: { x: 900, y: 300 },
  maxScrolls: 10,
  scrollDelay: 1500
};

