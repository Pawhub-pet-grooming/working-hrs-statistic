import { z } from 'zod';

const shopLoginCode = z.string().regex(/^\d{4}$/);
const uuid = z.string().uuid();

export const preferencesSchema = z.object({ preferredShopId: shopLoginCode.nullable() });
export type PreferencesDto = z.infer<typeof preferencesSchema>;

export const profileSchema = z
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
export type ProfileDto = z.infer<typeof profileSchema>;
