import { z } from 'zod';

const uuid = z.string().uuid();
const instant = z.iso.datetime({ offset: true });

export const clockSchema = z.object({
  operationId: uuid,
  workerId: z.string().regex(/^[1-9]\d{3}$/),
  shopId: z.string().regex(/^00\d{2}$/),
  type: z.enum(['SIGN_IN', 'SIGN_OUT']),
  occurredAt: instant,
  plannedStartAt: instant.optional(),
  expectedDailyCount: z.number().int().nonnegative().optional(),
  offline: z.boolean(),
  cameraStatus: z.enum(['AVAILABLE', 'UNAVAILABLE']),
  photoId: uuid.optional(),
  location: z
    .object({
      status: z.enum(['AVAILABLE', 'UNAVAILABLE']),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      accuracyMeters: z.number().nonnegative().max(100000).optional(),
      capturedAt: instant.optional(),
    })
    .optional(),
});
export type ClockDto = z.infer<typeof clockSchema>;

export const statusQuerySchema = z.object({
  shopId: z.string().optional(),
  workerId: z.string().optional(),
});
export type StatusQueryDto = z.infer<typeof statusQuerySchema>;
