import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVariableType } from '@/config/env.validate';
import { z } from 'zod';

interface LineTokenResponse {
  access_token: string;
  id_token: string;
}

interface LineProfile {
  sub: string;
  name?: string;
  picture?: string;
  email?: string;
}

@Injectable()
export class LineAuthService {
  constructor(
    private readonly configService: ConfigService<EnvVariableType, true>,
  ) {}

  async verifyCode(code: string, redirectUri: string): Promise<LineProfile> {
    // จำกัด callback ให้เป็นโดเมน Frontend ที่ตั้งไว้ ไม่รับ URL จากผู้ใช้โดยไม่มีการตรวจสอบ
    const origins =
      this.configService.get('CORS_ALLOWED_ORIGINS', { infer: true }) ?? [];
    const frontend = this.configService.get('FRONTEND_URL', { infer: true });
    const allowedCallbacks = [frontend, ...origins].map(
      (origin) => `${origin.replace(/\/$/, '')}/login`,
    );
    if (!allowedCallbacks.includes(redirectUri)) {
      throw new UnauthorizedException('Invalid LINE callback URL');
    }
    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.configService.get('LINE_CHANNEL_ID', {
          infer: true,
        }),
        client_secret: this.configService.get('LINE_CHANNEL_SECRET', {
          infer: true,
        }),
      }),
    });

    if (!tokenRes.ok) {
      throw new UnauthorizedException('Invalid LINE authorization code');
    }

    const tokenData = (await tokenRes.json()) as LineTokenResponse;

    const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: tokenData.id_token,
        client_id: this.configService.get('LINE_CHANNEL_ID', {
          infer: true,
        }),
      }),
    });

    if (!verifyRes.ok) {
      throw new UnauthorizedException('Invalid LINE token');
    }

    // อีเมลต้องมาจากผลตรวจ ID token ของ LINE เท่านั้น ไม่รับอีเมลที่ผู้ใช้กรอกมาแทน
    const profile = z
      .object({
        sub: z.string().min(1),
        name: z.string().optional(),
        picture: z.string().optional(),
        email: z.email().optional(),
      })
      .safeParse(await verifyRes.json());
    if (!profile.success)
      throw new UnauthorizedException('Invalid LINE profile');
    return profile.data;
  }
}
