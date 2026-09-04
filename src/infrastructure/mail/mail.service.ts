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
  private readonly transporter: Transporter;
  private readonly fromEmail: string;

  constructor(configService: ConfigService<EnvVariableType, true>) {
    const user = configService.get('GMAIL_SMTP_USER', { infer: true });
    this.fromEmail = user;
    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user,
        pass: configService.get('GMAIL_SMTP_APP_PASSWORD', { infer: true }),
      },
      // บังคับใช้ IPv4 เพราะ Container บน Railway/Cloud มักไม่รองรับ Outbound IPv6 ทำให้เชื่อมต่อค้าง
      family: 4,
      // จำกัดเวลาเชื่อมต่อไม่ให้ค้างนานเกินไป
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    } as nodemailer.TransportOptions);
  }

  async send(payload: MailPayload): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.fromEmail,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
      });
    } catch (error) {
      // บันทึกข้อผิดพลาดกรณีส่งอีเมลไม่สำเร็จ
      this.logger.error(
        `Failed to send email to ${payload.to}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // พิมพ์ข้อความและรหัส OTP ลงในคอนโซลล็อก เพื่อให้ทีมงานและผู้ดูแลระบบนำไปใช้ทดสอบได้ทันที
      this.logger.warn(
        `[FALLBACK EMAIL LOG] To: ${payload.to} | Subject: ${payload.subject} | Content: ${payload.text}`,
      );
    }
  }
}
