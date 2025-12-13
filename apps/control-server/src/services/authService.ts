/**
 * 인증 서비스
 * 아이디/비밀번호 기반 JWT 인증
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Redis from 'ioredis';

// 환경 변수
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// 사용자 정보
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'operator';
  createdAt: Date;
  lastLoginAt?: Date;
}

// 토큰 페이로드
export interface TokenPayload {
  userId: string;
  username: string;
  role: string;
}

// 로그인 결과
export interface LoginResult {
  success: boolean;
  token?: string;
  user?: Omit<User, 'passwordHash'>;
  error?: string;
}

export class AuthService {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.initializeDefaultUser();
  }

  /**
   * 기본 관리자 계정 생성
   */
  private async initializeDefaultUser(): Promise<void> {
    const adminExists = await this.redis.hexists('users', 'admin');
    
    if (!adminExists) {
      const passwordHash = await bcrypt.hash('admin1234', 10);
      const admin: User = {
        id: 'user_admin',
        username: 'admin',
        passwordHash,
        role: 'admin',
        createdAt: new Date()
      };
      
      await this.redis.hset('users', 'admin', JSON.stringify(admin));
      console.log('기본 관리자 계정 생성됨 (admin / admin1234)');
    }
  }

  /**
   * 사용자 등록
   */
  async register(username: string, password: string, role: 'admin' | 'operator' = 'operator'): Promise<User | null> {
    // 중복 확인
    const exists = await this.redis.hexists('users', username);
    if (exists) {
      return null;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user: User = {
      id: `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username,
      passwordHash,
      role,
      createdAt: new Date()
    };

    await this.redis.hset('users', username, JSON.stringify(user));
    console.log(`사용자 등록됨: ${username} (${role})`);

    return user;
  }

  /**
   * 로그인
   */
  async login(username: string, password: string): Promise<LoginResult> {
    // 사용자 조회
    const userJson = await this.redis.hget('users', username);
    if (!userJson) {
      return { success: false, error: '사용자를 찾을 수 없습니다' };
    }

    const user: User = JSON.parse(userJson);

    // 비밀번호 검증
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return { success: false, error: '비밀번호가 일치하지 않습니다' };
    }

    // 마지막 로그인 시간 업데이트
    user.lastLoginAt = new Date();
    await this.redis.hset('users', username, JSON.stringify(user));

    // JWT 토큰 생성
    const payload: TokenPayload = {
      userId: user.id,
      username: user.username,
      role: user.role
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    // 비밀번호 해시 제외하고 반환
    const { passwordHash, ...userWithoutPassword } = user;

    return {
      success: true,
      token,
      user: userWithoutPassword
    };
  }

  /**
   * 토큰 검증
   */
  verifyToken(token: string): TokenPayload | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
      return decoded;
    } catch (error) {
      return null;
    }
  }

  /**
   * 비밀번호 변경
   */
  async changePassword(username: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const userJson = await this.redis.hget('users', username);
    if (!userJson) {
      return false;
    }

    const user: User = JSON.parse(userJson);
    const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isValid) {
      return false;
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await this.redis.hset('users', username, JSON.stringify(user));

    return true;
  }

  /**
   * 사용자 목록 조회 (관리자용)
   */
  async getUsers(): Promise<Omit<User, 'passwordHash'>[]> {
    const allUsers = await this.redis.hgetall('users');
    return Object.values(allUsers).map(json => {
      const { passwordHash, ...user } = JSON.parse(json);
      return user;
    });
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

