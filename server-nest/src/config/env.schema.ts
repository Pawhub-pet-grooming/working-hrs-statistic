import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().min(1).optional(),
  SESSION_HOURS: z.coerce.number().int().positive().default(12),
  AWS_REGION: z.string().optional(),
  PHOTO_BUCKET: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_ENCRYPTION_KEY: z.string().optional(),
  GEOCODING_URL: z.string().optional(),
  PHOTO_STORAGE: z.enum(['local', 's3']).default('s3'),
  STORE_APK_BUCKET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
