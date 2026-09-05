import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { EnvVariableType } from '@/config/env.validate';

@Injectable()
export class GoogleAuthService {
  private readonly client: OAuth2Client;

  constructor(
    private readonly configService: ConfigService<EnvVariableType, true>,
  ) {
    this.client = new OAuth2Client(
      this.configService.get('GOOGLE_CLIENT_ID', { infer: true }),
    );
  }

  /** ตรวจลายเซ็น audience และอีเมลที่ยืนยันแล้วก่อนใช้เปิดบัญชีโดยไม่ส่ง OTP */
  async verifyIdToken(idToken: string): Promise<TokenPayload> {
    const ticket = await this.client
      .verifyIdToken({
        idToken,
        audience: this.configService.get('GOOGLE_CLIENT_ID', { infer: true }),
      })
      .catch(() => {
        throw new UnauthorizedException('Invalid Google token');
      });

    const payload = ticket.getPayload();

    if (!payload?.email || !payload.sub || payload.email_verified !== true) {
      throw new UnauthorizedException('Invalid Google token');
    }

    return payload;
  }
}
