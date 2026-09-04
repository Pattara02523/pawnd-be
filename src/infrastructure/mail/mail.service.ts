import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import { EnvVariableType } from '@/config/env.validate';

export interface MailPayload {
  to: string;
  subject: string;
  text: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null = null;
  private readonly fromEmail: string;
  private readonly resendApiKey?: string;

  constructor(configService: ConfigService<EnvVariableType, true>) {
    this.resendApiKey = configService.get('RESEND_API_KEY', { infer: true });
    const user = configService.get('GMAIL_SMTP_USER', { infer: true }) || '';
    const pass = configService.get('GMAIL_SMTP_APP_PASSWORD', { infer: true }) || '';
    this.fromEmail = user || 'onboarding@resend.dev';

    if (user && pass) {
      this.transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user,
          pass,
        },
        // บังคับใช้ IPv4 เพราะ Container บน Railway/Cloud มักไม่รองรับ Outbound IPv6 ทำให้เชื่อมต่อค้าง
        family: 4,
        // จำกัดเวลาเชื่อมต่อไม่ให้ค้างนานเกินไป
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 5000,
      } as nodemailer.TransportOptions);
    }
  }

  async send(payload: MailPayload): Promise<void> {
    // 1. ถ้ามี RESEND_API_KEY ให้ส่งผ่าน Resend HTTPS REST API (Port 443) ซึ่งทำงานบน Railway ได้ 100% ไม่ติดบล็อกพอร์ต
    if (this.resendApiKey) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'PAWND <onboarding@resend.dev>',
            to: [payload.to],
            subject: payload.subject,
            text: payload.text,
          }),
        });

        if (!response.ok) {
          const errorData = await response.text();
          throw new Error(`Resend API error: ${response.status} ${errorData}`);
        }

        this.logger.log(`Email successfully sent to ${payload.to} via Resend API`);
        return;
      } catch (error) {
        this.logger.error(
          `Failed to send email via Resend to ${payload.to}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 2. ถ้าไม่มี Resend หรือส่งไม่ผ่าน ให้ลองส่งผ่าน Gmail SMTP (ถ้ามีการตั้งค่าไว้)
    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: this.fromEmail,
          to: payload.to,
          subject: payload.subject,
          text: payload.text,
        });
        this.logger.log(`Email successfully sent to ${payload.to} via SMTP`);
        return;
      } catch (error) {
        // บันทึกข้อผิดพลาดกรณีส่งอีเมลไม่สำเร็จ
        this.logger.error(
          `Failed to send email to ${payload.to}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 3. พิมพ์ข้อความและรหัส OTP ลงในคอนโซลล็อก เพื่อให้ทีมงานและผู้ดูแลระบบนำไปใช้ทดสอบได้ทันที
    this.logger.warn(
      `[FALLBACK EMAIL LOG] To: ${payload.to} | Subject: ${payload.subject} | Content: ${payload.text}`,
    );
  }
}
