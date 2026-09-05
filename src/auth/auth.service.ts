import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '@/database/prisma.service';
import { BcryptService } from '@/infrastructure/hash/bcrypt.service';
import { MailService } from '@/infrastructure/mail/mail.service';
import { RegisterDto } from '@/auth/dto/register.dto';
import {
  generateOtp,
  generateToken,
  hashToken,
} from '@/common/utils/token.util';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { LoginDto } from './dto/login.dto';
import { AccessTokenService } from '@/infrastructure/jwt/access-token.service';
import { RefreshTokenService } from '@/infrastructure/jwt/refresh-token.service';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyTwoFactorDto } from './dto/verify-2fa.dto';
import { ResendTwoFactorDto } from './dto/resend-2fa.dto';
import {
  AuthProvider,
  UserRole,
  UserStatus,
} from '@/database/generated/prisma/enums';
import { GoogleAuthService } from '@/infrastructure/google/google-auth.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LineAuthService } from '@/infrastructure/line/line-auth.service';
import { LineLoginDto } from './dto/line-login.dto';
import { CompleteLineDto } from './dto/complete-line.dto';
import { ConfigService } from '@nestjs/config';
import { EnvVariableType } from '@/config/env.validate';

const EMAIL_VERIFICATION_TTL_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 3;
const TWO_FACTOR_TTL_MINUTES = 5;
const PASSWORD_RESET_TTL_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bcryptService: BcryptService,
    private readonly mailService: MailService,
    private readonly accessTokenService: AccessTokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly lineAuthService: LineAuthService,
    private readonly configService: ConfigService<EnvVariableType, true>,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await this.bcryptService.hash(dto.password);

    const { user, otp } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          passwordHash,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });

      const otp = generateOtp();

      await tx.emailVerification.create({
        data: {
          userId: user.id,
          email: user.email,
          otpHash: hashToken(otp),
          expiresAt: new Date(
            Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000,
          ),
        },
      });

      return { user, otp };
    });

    // ส่งอีเมลแบบ Asynchronous เพื่อให้หน้าบ้านได้รับ Response และเปลี่ยนไปหน้า OTP ทันทีโดยไม่ติด Timeout
    void this.mailService
      .send({
        to: user.email,
        subject: 'Verify your Pawnd account',
        text: `Your verification code: ${otp}`,
      })
      .catch((err) => {
        this.logger.warn(`Could not deliver email to ${user.email}: ${err}`);
      });

    return user;
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await this.bcryptService.compare(
      dto.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.status === 'PENDING_EMAIL_VERIFICATION') {
      throw new UnauthorizedException(
        'Please verify your email before logging in',
      );
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    return this.completeLogin(user);
  }

  private async completeLogin(
    user: {
      id: string;
      email: string;
      role: UserRole;
      firstName: string;
      lastName: string;
      status: UserStatus;
      avatarUrl: string | null;
      lastLoginAt: Date | null;
      twoFactorEnabled: boolean;
    },
    socialVerified = false,
  ) {
    const requiresTwoFactor =
      !socialVerified && (user.lastLoginAt === null || user.twoFactorEnabled);

    if (requiresTwoFactor) {
      const tempToken = await this.issueTwoFactorChallenge(user.id, user.email);
      return {
        tempToken,
        type: 'OTP_REQUIRED' as const,
        message: 'OTP sent to your email',
      };
    }

    const accessToken = await this.accessTokenService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = await this.refreshTokenService.issue(user.id);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        status: user.status,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  /** Google ตรวจ token และอีเมลจาก provider ก่อนเปิด session โดยไม่ส่ง OTP */
  async loginWithGoogle(dto: GoogleLoginDto) {
    const payload = await this.googleAuthService.verifyIdToken(dto.idToken);
    if (!payload.email || payload.email_verified !== true) {
      throw new UnauthorizedException('Google email is not verified');
    }
    return this.completeSocialLogin({
      provider: AuthProvider.GOOGLE,
      subject: payload.sub,
      email: payload.email,
      firstName: payload.given_name ?? 'Google',
      lastName: payload.family_name ?? 'User',
      avatarUrl: payload.picture,
    });
  }

  /** ใช้ provider subject เป็นตัวตนหลัก ไม่ผูกบัญชีจากอีเมลที่ตรงกันโดยอัตโนมัติ */
  private async completeSocialLogin(profile: {
    provider: 'GOOGLE' | 'LINE';
    subject: string;
    email?: string;
    firstName: string;
    lastName: string;
    avatarUrl?: string;
  }) {
    const user = await this.prisma.$transaction(async (tx) => {
      const account = await tx.authAccount.findUnique({
        where: {
          provider_providerAccountId: {
            provider: profile.provider,
            providerAccountId: profile.subject,
          },
        },
        include: { user: true },
      });
      if (account) {
        if (account.user.status === UserStatus.ACTIVE) return account.user;
        // อนุญาตบัญชี social เก่าที่ค้างยืนยันเฉพาะเมื่อ provider ยืนยันอีเมลเดิมและไม่มีรหัสผ่าน local
        if (
          account.user.status !== UserStatus.PENDING_EMAIL_VERIFICATION ||
          account.user.passwordHash ||
          !profile.email ||
          account.user.email !== profile.email
        ) {
          throw new UnauthorizedException(
            'บัญชีนี้ยังไม่สามารถเข้าสู่ระบบได้ กรุณาใช้ช่องทางเดิมหรือติดต่อผู้ดูแล',
          );
        }
        await tx.emailVerification.deleteMany({
          where: { userId: account.user.id },
        });
        return tx.user.update({
          where: { id: account.user.id },
          data: { status: UserStatus.ACTIVE, emailVerifiedAt: new Date() },
        });
      }
      if (!profile.email) {
        throw new BadRequestException(
          'กรุณาอนุญาตให้ LINE แชร์อีเมล แล้วลองเข้าสู่ระบบอีกครั้ง',
        );
      }
      const existing = await tx.user.findUnique({
        where: { email: profile.email },
      });
      if (existing) {
        throw new ConflictException(
          'ไม่สามารถสมัครด้วยช่องทางนี้ได้ กรุณาเข้าสู่ระบบด้วยช่องทางที่เคยใช้',
        );
      }
      // สร้าง user และบัญชี provider ใน transaction เดียว โดยอีเมลมาจาก token ที่ตรวจแล้วเท่านั้น
      return tx.user.create({
        data: {
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          avatarUrl: profile.avatarUrl,
          status: UserStatus.ACTIVE,
          emailVerifiedAt: new Date(),
          ...(profile.provider === AuthProvider.LINE
            ? { lineId: profile.subject }
            : {}),
          authAccounts: {
            create: {
              provider: profile.provider,
              providerAccountId: profile.subject,
            },
          },
        },
      });
    });
    return this.completeLogin(user, true);
  }

  async loginWithLine(dto: LineLoginDto) {
    const profile = await this.lineAuthService.verifyCode(
      dto.code,
      dto.redirectUri,
    );

    // บัญชีที่ผูกไว้ใช้ subject เดิมได้ ส่วนบัญชีใหม่ต้องมีอีเมลจาก LINE เท่านั้น
    return this.completeSocialLogin({
      provider: AuthProvider.LINE,
      subject: profile.sub,
      email: profile.email,
      firstName: profile.name ?? 'LINE',
      lastName: 'User',
      avatarUrl: profile.picture,
    });
  }

  /** ปิด endpoint เก่าที่รับอีเมลกรอกเอง ไม่ให้ข้ามการยืนยันจาก LINE */
  completeLineRegistration(dto: CompleteLineDto): never {
    void dto;
    throw new BadRequestException(
      'กรุณาอนุญาตให้ LINE แชร์อีเมล แล้วเริ่มเข้าสู่ระบบด้วย LINE อีกครั้ง',
    );
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        avatarUrl: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return { user };
  }

  async refresh(dto: RefreshTokenDto) {
    const userId = await this.refreshTokenService.verify(dto.refreshToken);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.refreshTokenService.revoke(dto.refreshToken);

    const accessToken = await this.accessTokenService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    const refreshToken = await this.refreshTokenService.issue(user.id);

    return { accessToken, refreshToken };
  }

  async logout(dto: RefreshTokenDto) {
    await this.refreshTokenService.revoke(dto.refreshToken);
    return { message: 'Logged out successfully' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (user) {
      const token = generateToken();

      await this.prisma.passwordResetToken.deleteMany({
        where: { userId: user.id },
      });

      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(
            Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000,
          ),
        },
      });

      const frontendUrl = this.configService.get('FRONTEND_URL', {
        infer: true,
      });
      const resetLink = `${frontendUrl.replace(/\/$/, '')}/reset-password?token=${token}`;

      void this.mailService
        .send({
          to: user.email,
          subject: 'Reset your Pawnd password',
          text: `Click the link to reset your password: ${resetLink}`,
        })
        .catch((err) => {
          this.logger.warn(
            `Could not deliver reset email to ${user.email}: ${err}`,
          );
        });
    }

    return { message: 'Password reset link sent to email' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash: hashToken(dto.token),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const passwordHash = await this.bcryptService.hash(dto.newPassword);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: resetToken.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { message: 'Password reset successfully' };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const verification = await this.prisma.emailVerification.findFirst({
      where: {
        email: dto.email,
        expiresAt: { gt: new Date() },
      },
    });

    if (!verification) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const isMatch = verification.otpHash === hashToken(dto.otp);

    if (!isMatch) {
      const attempts = verification.attempts + 1;

      if (attempts >= MAX_OTP_ATTEMPTS) {
        await this.prisma.emailVerification.delete({
          where: { id: verification.id },
        });
      } else {
        await this.prisma.emailVerification.update({
          where: { id: verification.id },
          data: { attempts },
        });
      }

      throw new BadRequestException('Invalid or expired verification code');
    }

    await this.prisma.$transaction([
      this.prisma.emailVerification.delete({
        where: { id: verification.id },
      }),
      this.prisma.user.update({
        where: { id: verification.userId },
        data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      }),
    ]);

    return { message: 'Email verified successfully' };
  }

  async resendVerification(dto: ResendVerificationDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.status !== 'PENDING_EMAIL_VERIFICATION') {
      throw new BadRequestException('Email is already verified');
    }

    await this.sendVerificationEmail(user.id, user.email);

    return { message: 'Verification email resent' };
  }

  private async sendVerificationEmail(userId: string, email: string) {
    const otp = generateOtp();

    await this.prisma.emailVerification.deleteMany({
      where: { email },
    });

    await this.prisma.emailVerification.create({
      data: {
        userId,
        email,
        otpHash: hashToken(otp),
        expiresAt: new Date(
          Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000,
        ),
      },
    });

    void this.mailService
      .send({
        to: email,
        subject: 'Verify your Pawnd account',
        text: `Your verification code: ${otp}`,
      })
      .catch((err) => {
        this.logger.warn(`Could not deliver resend email to ${email}: ${err}`);
      });
  }

  async verifyTwoFactor(dto: VerifyTwoFactorDto) {
    const challenge = await this.prisma.twoFactorChallenge.findFirst({
      where: {
        tempTokenHash: hashToken(dto.tempToken),
        expiresAt: { gt: new Date() },
      },
    });

    if (!challenge) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const isMatch = challenge.otpHash === hashToken(dto.otp);

    if (!isMatch) {
      const attempts = challenge.attempts + 1;

      if (attempts >= MAX_OTP_ATTEMPTS) {
        await this.prisma.twoFactorChallenge.delete({
          where: { id: challenge.id },
        });
      } else {
        await this.prisma.twoFactorChallenge.update({
          where: { id: challenge.id },
          data: { attempts },
        });
      }

      throw new BadRequestException('Invalid or expired verification code');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
    });

    await this.prisma.twoFactorChallenge.delete({
      where: { id: challenge.id },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = await this.accessTokenService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = await this.refreshTokenService.issue(user.id);

    return { accessToken, refreshToken };
  }

  async resendTwoFactor(dto: ResendTwoFactorDto) {
    const challenge = await this.prisma.twoFactorChallenge.findFirst({
      where: { tempTokenHash: hashToken(dto.tempToken) },
    });

    if (!challenge) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    const otp = generateOtp();

    await this.prisma.twoFactorChallenge.update({
      where: { id: challenge.id },
      data: {
        otpHash: hashToken(otp),
        attempts: 0,
        expiresAt: new Date(Date.now() + TWO_FACTOR_TTL_MINUTES * 60 * 1000),
      },
    });

    void this.mailService
      .send({
        to: user.email,
        subject: 'Your Pawnd login code',
        text: `Your login verification code: ${otp}`,
      })
      .catch((err) => {
        this.logger.warn(`Could not deliver 2FA email: ${err}`);
      });

    return { message: 'Verification code resent' };
  }

  private async issueTwoFactorChallenge(
    userId: string,
    email: string,
  ): Promise<string> {
    const tempToken = generateToken();
    const otp = generateOtp();

    await this.prisma.twoFactorChallenge.deleteMany({
      where: { userId },
    });

    await this.prisma.twoFactorChallenge.create({
      data: {
        userId,
        tempTokenHash: hashToken(tempToken),
        otpHash: hashToken(otp),
        expiresAt: new Date(Date.now() + TWO_FACTOR_TTL_MINUTES * 60 * 1000),
      },
    });

    void this.mailService
      .send({
        to: email,
        subject: 'Your Pawnd login code',
        text: `Your login verification code: ${otp}`,
      })
      .catch((err) => {
        this.logger.warn(`Could not deliver 2FA email: ${err}`);
      });

    return tempToken;
  }

  async enableTwoFactor(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true },
    });

    return { message: '2FA enabled successfully' };
  }

  async disableTwoFactor(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false },
    });

    return { message: '2FA disabled successfully' };
  }
}
