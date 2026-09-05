import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@/database/generated/prisma/enums';
import { PrismaService } from '@/database/prisma.service';
import { BcryptService } from '@/infrastructure/hash/bcrypt.service';
import { GoogleAuthService } from '@/infrastructure/google/google-auth.service';
import { AccessTokenService } from '@/infrastructure/jwt/access-token.service';
import { RefreshTokenService } from '@/infrastructure/jwt/refresh-token.service';
import { LineAuthService } from '@/infrastructure/line/line-auth.service';
import { MailService } from '@/infrastructure/mail/mail.service';
import { hashToken } from '@/common/utils/token.util';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';

describe('AuthService token renewal', () => {
  let service: AuthService;

  const userId = '10000000-0000-4000-8000-000000000001';
  const activeUser = {
    id: userId,
    email: 'user@example.com',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
  };
  const challenge = {
    id: '20000000-0000-4000-8000-000000000002',
    userId,
    tempTokenHash: hashToken('temporary-token'),
    otpHash: hashToken('123456'),
    attempts: 0,
    expiresAt: new Date('2026-08-21T12:00:00.000Z'),
    createdAt: new Date('2026-08-21T11:55:00.000Z'),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    twoFactorChallenge: {
      findFirst: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    },
  };
  const bcryptService = {
    compare: jest.fn(),
    hash: jest.fn(),
  };
  const mailService = {
    send: jest.fn(),
  };
  const accessTokenService = {
    sign: jest.fn(),
  };
  const refreshTokenService = {
    verify: jest.fn(),
    revoke: jest.fn(),
    issue: jest.fn(),
  };
  const googleAuthService = {
    verifyIdToken: jest.fn(),
  };
  const lineAuthService = {
    verifyCode: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.user.update.mockResolvedValue(activeUser);
    prisma.twoFactorChallenge.findFirst.mockResolvedValue(challenge);
    prisma.twoFactorChallenge.delete.mockResolvedValue(challenge);
    refreshTokenService.verify.mockResolvedValue(userId);
    refreshTokenService.revoke.mockResolvedValue(undefined);
    refreshTokenService.issue.mockResolvedValue('new-refresh-token');
    accessTokenService.sign.mockResolvedValue('new-access-token');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        // Mock config ที่ AuthService ใช้ เพื่อให้ทดสอบเส้นทางรหัสผ่านเดิมได้
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: BcryptService, useValue: bcryptService },
        { provide: MailService, useValue: mailService },
        { provide: AccessTokenService, useValue: accessTokenService },
        { provide: RefreshTokenService, useValue: refreshTokenService },
        { provide: GoogleAuthService, useValue: googleAuthService },
        { provide: LineAuthService, useValue: lineAuthService },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('refreshes tokens for an active user', async () => {
    await expect(
      service.refresh({ refreshToken: 'valid-refresh-token' }),
    ).resolves.toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    expect(refreshTokenService.revoke).toHaveBeenCalledWith(
      'valid-refresh-token',
    );
    expect(accessTokenService.sign).toHaveBeenCalledWith({
      sub: userId,
      email: activeUser.email,
      role: activeUser.role,
    });
    expect(refreshTokenService.issue).toHaveBeenCalledWith(userId);
  });

  it.each([UserStatus.DELETED, UserStatus.SUSPENDED])(
    'rejects refresh for a %s user without issuing tokens',
    async (status) => {
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, status });

      await expect(
        service.refresh({ refreshToken: 'valid-refresh-token' }),
      ).rejects.toThrow(
        new UnauthorizedException('Invalid or expired refresh token'),
      );
      expect(refreshTokenService.revoke).not.toHaveBeenCalled();
      expect(accessTokenService.sign).not.toHaveBeenCalled();
      expect(refreshTokenService.issue).not.toHaveBeenCalled();
    },
  );

  it('completes two-factor authentication for an active user', async () => {
    await expect(
      service.verifyTwoFactor({
        tempToken: 'temporary-token',
        otp: '123456',
      }),
    ).resolves.toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    expect(prisma.twoFactorChallenge.delete).toHaveBeenCalledWith({
      where: { id: challenge.id },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  it.each([UserStatus.DELETED, UserStatus.SUSPENDED, UserStatus.BLACKLISTED])(
    'consumes a verified challenge but issues no tokens for a %s user',
    async (status) => {
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, status });
      prisma.twoFactorChallenge.findFirst
        .mockResolvedValueOnce(challenge)
        .mockResolvedValueOnce(null);
      const dto = { tempToken: 'temporary-token', otp: '123456' };

      await expect(service.verifyTwoFactor(dto)).rejects.toThrow(
        new UnauthorizedException('Invalid or expired verification code'),
      );
      expect(prisma.twoFactorChallenge.delete).toHaveBeenCalledWith({
        where: { id: challenge.id },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(accessTokenService.sign).not.toHaveBeenCalled();
      expect(refreshTokenService.issue).not.toHaveBeenCalled();

      await expect(service.verifyTwoFactor(dto)).rejects.toThrow(
        BadRequestException,
      );
    },
  );
});
