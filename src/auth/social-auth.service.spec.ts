import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '@/database/prisma.service';
import { BcryptService } from '@/infrastructure/hash/bcrypt.service';
import { MailService } from '@/infrastructure/mail/mail.service';
import { AccessTokenService } from '@/infrastructure/jwt/access-token.service';
import { RefreshTokenService } from '@/infrastructure/jwt/refresh-token.service';
import { GoogleAuthService } from '@/infrastructure/google/google-auth.service';
import { LineAuthService } from '@/infrastructure/line/line-auth.service';
import { UserStatus } from '@/database/generated/prisma/enums';

/** ทดสอบขอบเขตความปลอดภัยของ social โดย mock provider และฐานข้อมูล ไม่มีบัญชีจริง */
describe('Social authentication without OTP', () => {
  let service: AuthService;

  it('rejects a new LINE identity without email and sends no OTP', async () => {
    line.verifyCode.mockResolvedValue({ sub: 'new-line-sub' });
    await expect(
      service.loginWithLine({
        code: 'test',
        redirectUri: 'https://pawnd.vercel.app/login',
      }),
    ).rejects.toThrow('แชร์อีเมล');
    expect(db.user.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect(access.sign).not.toHaveBeenCalled();
  });

  it('rejects the legacy manual email endpoint without touching accounts', () => {
    expect(() =>
      service.completeLineRegistration({
        tempToken: 'old-token',
        email: 'test@example.com',
      }),
    ).toThrow('แชร์อีเมล');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });
  const activeUser = {
    id: 'test-user',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    role: 'USER',
    status: UserStatus.ACTIVE,
    passwordHash: null,
    avatarUrl: null,
    lastLoginAt: null,
    twoFactorEnabled: true,
  };
  const db = {
    twoFactorChallenge: { deleteMany: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    authAccount: { findUnique: jest.fn() },
    emailVerification: { deleteMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn() };
  const google = { verifyIdToken: jest.fn() };
  const line = { verifyCode: jest.fn() };
  const mail = { send: jest.fn() };
  const access = { sign: jest.fn() };
  const refresh = { issue: jest.fn() };
  const bcrypt = { compare: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof db) => Promise<unknown>) => callback(db),
    );
    db.user.create.mockResolvedValue(activeUser);
    db.user.update.mockResolvedValue(activeUser);
    google.verifyIdToken.mockResolvedValue({
      sub: 'google-sub',
      email: activeUser.email,
      email_verified: true,
    });
    line.verifyCode.mockResolvedValue({
      sub: 'line-sub',
      email: activeUser.email,
    });
    access.sign.mockResolvedValue('test-access');
    refresh.issue.mockResolvedValue('test-refresh');
    mail.send.mockResolvedValue(undefined);
    bcrypt.compare.mockResolvedValue(true);
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: BcryptService, useValue: bcrypt },
        { provide: MailService, useValue: mail },
        { provide: AccessTokenService, useValue: access },
        { provide: RefreshTokenService, useValue: refresh },
        { provide: GoogleAuthService, useValue: google },
        { provide: LineAuthService, useValue: line },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('keeps OTP for password login even after adding social bypass', async () => {
    db.user.findUnique.mockResolvedValue({
      ...activeUser,
      passwordHash: 'test-hash',
    });
    await expect(
      service.login({ email: activeUser.email, password: 'test-password' }),
    ).resolves.toHaveProperty('type', 'OTP_REQUIRED');
    expect(mail.send).toHaveBeenCalled();
    expect(access.sign).not.toHaveBeenCalled();
  });

  it.each(['GOOGLE', 'LINE'])(
    'creates an active %s account and session without any OTP email',
    async (provider) => {
      const result =
        provider === 'GOOGLE'
          ? await service.loginWithGoogle({ idToken: 'test' })
          : await service.loginWithLine({
              code: 'test',
              redirectUri: 'https://pawnd.vercel.app/login',
            });
      expect(result).toMatchObject({
        accessToken: 'test-access',
        refreshToken: 'test-refresh',
      });
      expect(db.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: UserStatus.ACTIVE,
          emailVerifiedAt: expect.any(Date),
        }),
      });
      expect(mail.send).not.toHaveBeenCalled();
    },
  );

  it.each(['GOOGLE', 'LINE'])(
    'logs in linked %s users even on first login with local 2FA enabled',
    async (provider) => {
      db.authAccount.findUnique.mockResolvedValue({ user: activeUser });
      const result =
        provider === 'GOOGLE'
          ? await service.loginWithGoogle({ idToken: 'test' })
          : await service.loginWithLine({
              code: 'test',
              redirectUri: 'https://pawnd.vercel.app/login',
            });
      expect(result).toHaveProperty('accessToken');
      expect(mail.send).not.toHaveBeenCalled();
      expect(db.user.create).not.toHaveBeenCalled();
    },
  );

  it.each([UserStatus.SUSPENDED, UserStatus.DELETED, UserStatus.BLACKLISTED])(
    'rejects linked %s accounts',
    async (status) => {
      db.authAccount.findUnique.mockResolvedValue({
        user: { ...activeUser, status },
      });
      await expect(
        service.loginWithGoogle({ idToken: 'test' }),
      ).rejects.toThrow();
      expect(access.sign).not.toHaveBeenCalled();
    },
  );

  it('rejects an unverified Google email before accessing the database', async () => {
    google.verifyIdToken.mockResolvedValue({
      sub: 'google-sub',
      email: activeUser.email,
      email_verified: false,
    });
    await expect(
      service.loginWithGoogle({ idToken: 'test' }),
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['GOOGLE', 'LINE'])(
    'does not auto-link %s to an existing local email',
    async (provider) => {
      db.user.findUnique.mockResolvedValue(activeUser);
      const request =
        provider === 'GOOGLE'
          ? service.loginWithGoogle({ idToken: 'test' })
          : service.loginWithLine({
              code: 'test',
              redirectUri: 'https://pawnd.vercel.app/login',
            });
      await expect(request).rejects.toThrow();
      expect(db.user.create).not.toHaveBeenCalled();
      expect(access.sign).not.toHaveBeenCalled();
    },
  );

  it('activates a legacy social-only pending account with the same provider email', async () => {
    db.authAccount.findUnique.mockResolvedValue({
      user: { ...activeUser, status: UserStatus.PENDING_EMAIL_VERIFICATION },
    });
    await expect(
      service.loginWithGoogle({ idToken: 'test' }),
    ).resolves.toHaveProperty('accessToken');
    expect(db.emailVerification.deleteMany).toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('does not activate a pending account carrying a local password', async () => {
    db.authAccount.findUnique.mockResolvedValue({
      user: {
        ...activeUser,
        status: UserStatus.PENDING_EMAIL_VERIFICATION,
        passwordHash: 'test-hash',
      },
    });
    await expect(
      service.loginWithGoogle({ idToken: 'test' }),
    ).rejects.toThrow();
    expect(db.emailVerification.deleteMany).not.toHaveBeenCalled();
    expect(access.sign).not.toHaveBeenCalled();
  });

  it('allows an active linked LINE identity without email scope', async () => {
    line.verifyCode.mockResolvedValue({ sub: 'line-sub' });
    db.authAccount.findUnique.mockResolvedValue({ user: activeUser });
    await expect(
      service.loginWithLine({
        code: 'test',
        redirectUri: 'https://pawnd.vercel.app/login',
      }),
    ).resolves.toHaveProperty('accessToken');
  });
});
