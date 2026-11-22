import { z } from 'zod';

const accountId = z.string().regex(/^\d{4}$/);
const email = z.email();
const registerEmail = z.email().max(254).transform((v) => v.toLowerCase());

export const loginSchema = z
  .object({ password: z.string().min(1), email: email.optional(), accountId: accountId.optional() })
  .refine((body) => !!body.email !== !!body.accountId);
export type LoginDto = z.infer<typeof loginSchema>;

export const registerSchema = z
  .object({ email: registerEmail, confirmEmail: registerEmail })
  .strict()
  .refine((v) => v.email === v.confirmEmail, 'Email addresses must match');
export type RegisterDto = z.infer<typeof registerSchema>;

export const requestPasswordLinkSchema = z
  .object({ accountId: accountId.optional(), email: email.optional() })
  .refine((b) => !!b.accountId !== !!b.email);
export type RequestPasswordLinkDto = z.infer<typeof requestPasswordLinkSchema>;

export const consumePasswordLinkSchema = z.object({
  token: z.string().min(20),
  newPassword: z.string().min(6).max(128),
});
export type ConsumePasswordLinkDto = z.infer<typeof consumePasswordLinkSchema>;

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(6).max(128) })
  .strict();
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
