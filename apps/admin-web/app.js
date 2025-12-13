/**
 * Android 자동화 제어 센터 웹앱
 */

// API 기본 URL
const API_BASE_URL = process.env.API_URL || 'http://localhost:3000/api';
const API_BASE = API_BASE_URL.replace('/api', '');

// 인증 토큰 관리
const Auth = {
  getToken() {
    return localStorage.getItem('auth_token');
  },
  
  setToken(token) {
    localStorage.setItem('auth_token', token);
  },
  
  removeToken() {
    localStorage.removeItem('auth_token');
  },
  
  isAuthenticated() {
    return !!this.getToken();
  }
};

// API 클라이언트
const API = {
  async request(endpoint, options = {}) {
    const token = Auth.getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers
      });
      
      if (response.status === 401) {
        Auth.removeToken();
        showScreen('login-screen');
        showAlert('login-error', '인증이 만료되었습니다. 다시 로그인해주세요.', 'danger');
        throw new Error('Unauthorized');
      }
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || '요청 실패');
      }
      
      return data;
    } catch (error) {
      console.error('API 요청 오류:', error);
      throw error;
    }
  },
  
  // 인증
  async login(username, password) {
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
  },
  
  async getMe() {
    return this.request('/auth/me');
  },
  
  async changePassword(oldPassword, newPassword) {
    return this.request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword })
    });
  },
  
  // 검색 요청
  async createSearchRequest(data) {
    return this.request('/search-requests', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },
  
  async getSearchRequest(id) {
    return this.request(`/search-requests/${id}`);
  },
  
  async getSearchRequests() {
    return this.request('/search-requests?limit=50');
  },
  
  async getPendingCount() {
    return this.request('/search-requests/pending/count');
  },
  
  // 기기 통계
  async getDeviceStats() {
    return this.request('/devices/stats');
  },
  
  async getAvailableDevices() {
    return this.request('/devices/available');
  },
  
  // 스케줄러
  async getSchedulerStatus() {
    return this.request('/scheduler/status');
  },
  
  async startScheduler() {
    return this.request('/scheduler/start', { method: 'POST' });
  },
  
  async stopScheduler() {
    return this.request('/scheduler/stop', { method: 'POST' });
  }
};

// 화면 전환
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });
  document.getElementById(screenId).classList.add('active');
}

// 알림 표시
function showAlert(alertId, message, variant = 'info') {
  const alert = document.getElementById(alertId);
  if (alert) {
    alert.textContent = message;
    alert.variant = variant;
    alert.style.display = 'block';
    alert.show();
  }
}

function hideAlert(alertId) {
  const alert = document.getElementById(alertId);
  if (alert) {
    alert.style.display = 'none';
    alert.hide();
  }
}

// 상태 배지 생성
function createStatusBadge(status) {
  const badge = document.createElement('wa-badge');
  const statusMap = {
    pending: { text: '대기 중', variant: 'info' },
    processing: { text: '처리 중', variant: 'warning' },
    found: { text: '발견', variant: 'success' },
    not_found: { text: '미발견', variant: 'danger' },
    failed: { text: '실패', variant: 'danger' }
  };
  
  const info = statusMap[status] || { text: status, variant: 'default' };
  badge.textContent = info.text;
  badge.variant = info.variant;
  return badge;
}

// 날짜 포맷
function formatDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleString('ko-KR');
}

// 로그인
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert('login-error');
  
  const formData = new FormData(e.target);
  const username = formData.get('username');
  const password = formData.get('password');
  
  try {
    const result = await API.login(username, password);
    Auth.setToken(result.token);
    
    // 사용자 정보 저장
    localStorage.setItem('user_info', JSON.stringify(result.user));
    
    // 대시보드로 이동
    await initializeDashboard();
    showScreen('dashboard-screen');
  } catch (error) {
    showAlert('login-error', error.message || '로그인 실패', 'danger');
  }
});

// 로그아웃
document.getElementById('logout-btn')?.addEventListener('click', () => {
  Auth.removeToken();
  localStorage.removeItem('user_info');
  showScreen('login-screen');
  document.getElementById('login-form').reset();
});

// 대시보드 초기화
async function initializeDashboard() {
  try {
    // 사용자 정보 표시
    const userInfo = JSON.parse(localStorage.getItem('user_info') || '{}');
    const userBadge = document.getElementById('user-badge');
    if (userBadge) {
      userBadge.textContent = userInfo.username || '사용자';
      if (userInfo.role === 'admin') {
        document.getElementById('settings-tab').style.display = 'block';
      }
    }
    
    // 통계 업데이트
    await updateDashboard();
    
    // 자동 새로고침 (30초마다)
    setInterval(updateDashboard, 30000);
  } catch (error) {
    console.error('대시보드 초기화 오류:', error);
  }
}

// 대시보드 업데이트
async function updateDashboard() {
  try {
    // 기기 통계
    const stats = await API.getDeviceStats();
    document.getElementById('stats-online-devices').textContent = stats.onlineDevices || 0;
    
    // 대기 중인 요청 수
    const pending = await API.getPendingCount();
    document.getElementById('stats-pending-requests').textContent = pending.pendingCount || 0;
    
    // 스케줄러 상태
    const scheduler = await API.getSchedulerStatus();
    const statusBadge = document.getElementById('scheduler-status-badge');
    if (statusBadge) {
      statusBadge.textContent = scheduler.isRunning ? '실행 중' : '중지됨';
      statusBadge.variant = scheduler.isRunning ? 'success' : 'default';
    }
    
    document.getElementById('scheduler-pending-count').textContent = scheduler.pendingSearchRequests || 0;
    document.getElementById('scheduler-current-job').textContent = 
      scheduler.currentJob ? `${scheduler.currentJob.type} (${scheduler.currentJob.id})` : '없음';
    document.getElementById('scheduler-rotation').textContent = 
      `자동화${scheduler.automationRotationIndex + 1}`;
    
    document.getElementById('stats-completed-jobs').textContent = scheduler.totalJobsCompleted || 0;
    document.getElementById('stats-current-job').textContent = 
      scheduler.currentJob?.commandType || scheduler.currentJob?.type || '없음';
  } catch (error) {
    console.error('대시보드 업데이트 오류:', error);
  }
}

// 스케줄러 제어
document.getElementById('scheduler-start-btn')?.addEventListener('click', async () => {
  try {
    await API.startScheduler();
    await updateDashboard();
    showAlert('request-success', '스케줄러가 시작되었습니다', 'success');
  } catch (error) {
    showAlert('request-error', error.message, 'danger');
  }
});

document.getElementById('scheduler-stop-btn')?.addEventListener('click', async () => {
  try {
    await API.stopScheduler();
    await updateDashboard();
    showAlert('request-success', '스케줄러가 중지되었습니다', 'success');
  } catch (error) {
    showAlert('request-error', error.message, 'danger');
  }
});

document.getElementById('scheduler-refresh-btn')?.addEventListener('click', async () => {
  await updateDashboard();
});

// 검색 요청 등록
document.getElementById('search-request-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert('request-success');
  hideAlert('request-error');
  
  const formData = new FormData(e.target);
  const data = {
    keyword: formData.get('keyword'),
    title: formData.get('title'),
    url: formData.get('url'),
    priority: parseInt(formData.get('priority')) || 10
  };
  
  try {
    const result = await API.createSearchRequest(data);
    showAlert('request-success', `검색 요청이 등록되었습니다 (ID: ${result.request.id})`, 'success');
    e.target.reset();
    
    // 대시보드 업데이트
    await updateDashboard();
  } catch (error) {
    showAlert('request-error', error.message || '요청 등록 실패', 'danger');
  }
});

// 요청 목록 조회
async function loadRequestsList() {
  const container = document.getElementById('requests-list-container');
  if (!container) return;
  
  container.innerHTML = '<wa-spinner></wa-spinner>';
  
  try {
    const requests = await API.getSearchRequests();
    
    if (requests.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--wa-color-neutral-600); padding: 2rem;">등록된 요청이 없습니다</p>';
      return;
    }
    
    container.innerHTML = requests.map(request => `
      <div class="request-item">
        <div class="request-info">
          <div class="request-title">${request.keyword}</div>
          <div class="request-meta">
            <span><wa-icon name="fa-solid fa-heading"></wa-icon> ${request.title}</span>
            <span><wa-icon name="fa-solid fa-link"></wa-icon> ${new URL(request.url).hostname}</span>
            <span><wa-icon name="fa-solid fa-clock"></wa-icon> ${formatDate(request.createdAt)}</span>
          </div>
        </div>
        <div class="request-status">
          ${createStatusBadge(request.status).outerHTML}
          ${request.foundBy ? `<small>발견 기기: ${request.foundBy}</small>` : ''}
          ${request.currentPhase ? `<small>단계: ${request.currentPhase}</small>` : ''}
        </div>
      </div>
    `).join('');
  } catch (error) {
    container.innerHTML = `<wa-alert variant="danger">목록 조회 실패: ${error.message}</wa-alert>`;
  }
}

document.getElementById('refresh-list-btn')?.addEventListener('click', loadRequestsList);

// 비밀번호 변경
document.getElementById('change-password-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const oldPassword = formData.get('oldPassword');
  const newPassword = formData.get('newPassword');
  const confirmPassword = formData.get('confirmPassword');
  
  if (newPassword !== confirmPassword) {
    alert('새 비밀번호가 일치하지 않습니다');
    return;
  }
  
  try {
    await API.changePassword(oldPassword, newPassword);
    alert('비밀번호가 변경되었습니다');
    e.target.reset();
  } catch (error) {
    alert(error.message || '비밀번호 변경 실패');
  }
});

// 앱 시작
document.addEventListener('DOMContentLoaded', async () => {
  // 인증 확인
  if (Auth.isAuthenticated()) {
    try {
      await API.getMe();
      await initializeDashboard();
      showScreen('dashboard-screen');
    } catch (error) {
      Auth.removeToken();
      showScreen('login-screen');
    }
  } else {
    showScreen('login-screen');
  }
  
  // 탭 변경 시 목록 새로고침
  document.querySelector('wa-tab[panel="requests-list"]')?.addEventListener('click', () => {
    loadRequestsList();
  });
});

// Web Awesome 컴포넌트 로드 확인
if (typeof customElements !== 'undefined') {
  // 컴포넌트가 로드될 때까지 대기
  customElements.whenDefined('wa-page').then(() => {
    console.log('Web Awesome 컴포넌트 로드 완료');
  });
}

