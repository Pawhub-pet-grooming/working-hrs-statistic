import { z } from 'zod';

const shopLoginCode = z.string().regex(/^00\d{2}$/);
const uuid = z.string().uuid();

export const createAccountSchema = z.object({
  operationId: uuid,
  name: z.string().trim().min(1),
  email: z.email(),
  shopIds: z.array(shopLoginCode).default([]),
  contact: z.string().optional(),
  address: z.string().trim().max(500).optional(),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(50).optional(),
  preferredShopId: shopLoginCode.nullable().optional(),
});
export type CreateAccountDto = z.infer<typeof createAccountSchema>;

export const managedProfileSchema = z
  .object({
    operationId: uuid,
    expectedVersion: z.number().int().positive(),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100),
    address: z.string().trim().max(500),
    phone: z.string().trim().max(50),
    preferredShopId: shopLoginCode.nullable(),
  })
  .strict();
export type ManagedProfileDto = z.infer<typeof managedProfileSchema>;

export const removeAccountSchema = z
  .object({ operationId: uuid, expectedVersion: z.number().int().positive() })
  .strict();
export type RemoveAccountDto = z.infer<typeof removeAccountSchema>;

export const approveAccountSchema = z.object({ operationId: uuid }).strict();
export type ApproveAccountDto = z.infer<typeof approveAccountSchema>;

export const resendInvitationSchema = z.object({ operationId: uuid });
export type ResendInvitationDto = z.infer<typeof resendInvitationSchema>;
