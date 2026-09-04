import { Logger } from '@nestjs/common';
import z from 'zod';
import { parseCorsAllowedOrigins } from './cors.config';

const envSchema = z.object({
  PORT: z.coerce.number().int().max(65535).positive(),
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRE_IN: z.coerce.number().int().positive(),
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),
  FRONTEND_URL: z.string().min(1),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  LINE_CHANNEL_ID: z.string().min(1),
  LINE_CHANNEL_SECRET: z.string().min(1),
  NOMINATIM_BASE_URL: z.url().default('https://nominatim.openstreetmap.org'),
  NOMINATIM_USER_AGENT: z
    .string()
    .trim()
    .min(1)
    .refine((value) => /PAWND/i.test(value), {
      message: 'NOMINATIM_USER_AGENT must identify PAWND',
    })
    .default('PAWND/1.0'),
  NOMINATIM_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(10000)
    .default(5000),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().min(1),
  // z.coerce.boolean() แปลง string 'false' เป็น true ผิดพลาด (non-empty string ทุกตัวเป็น truthy)
  // ต้องใช้ custom transform แทน
  AI_MOCK_MODE: z
    .string()
    .optional()
    .transform((val) => val === 'true')
    .default('false' as unknown as boolean),
  AI_ANALYZE_IMAGE_MODEL: z.string().min(1),
  AI_ANALYZE_IMAGE_MODEL_FREE: z.string().min(1),
  AI_IMAGE_EMBEDDING_MODEL: z.string().min(1),
  AI_IMAGE_EMBEDDING_DIMENSION: z.coerce.number().int().positive(),
  GMAIL_SMTP_USER: z.string().optional().default(''),
  GMAIL_SMTP_APP_PASSWORD: z.string().optional().default(''),
  RESEND_API_KEY: z.string().optional(),
});

type ParsedEnvironment = z.infer<typeof envSchema>;

export type EnvVariableType = Omit<
  ParsedEnvironment,
  'CORS_ALLOWED_ORIGINS'
> & {
  CORS_ALLOWED_ORIGINS: string[];
};

export function validate(config: Record<string, any>): EnvVariableType {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const logger = new Logger('ENV Validation');
    logger.error('ENV validation fail', z.prettifyError(parsed.error));
    console.error('ENV validation fail', z.prettifyError(parsed.error));
    throw new Error('ENV Validation failed');
  }

  try {
    return {
      ...parsed.data,
      CORS_ALLOWED_ORIGINS: parseCorsAllowedOrigins(
        parsed.data.CORS_ALLOWED_ORIGINS,
        parsed.data.FRONTEND_URL,
      ),
    };
  } catch (error: unknown) {
    const logger = new Logger('ENV Validation');
    logger.error(
      error instanceof Error ? error.message : 'CORS configuration is invalid',
    );
    throw new Error('ENV Validation failed');
  }
}
