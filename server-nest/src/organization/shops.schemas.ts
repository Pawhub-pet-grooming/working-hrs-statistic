import { z } from 'zod';

const shopLoginCode = z
  .string()
  .regex(/^00\d{2}$/)
  .refine((v) => v !== '0000');

export const uuidParamSchema = z.string().uuid();

export const fourDigitCodeParamSchema = z.string().regex(/^[0-9]{4}$/);

export const createShopSchema = z.object({
  operationId: z.string().uuid(),
  shopId: shopLoginCode,
  name: z.string().trim().min(1),
  address: z.string().trim().min(1).max(500),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});
export type CreateShopDto = z.infer<typeof createShopSchema>;

export const shopProfileSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().min(1).max(500),
  })
  .strict();
export type ShopProfileDto = z.infer<typeof shopProfileSchema>;
