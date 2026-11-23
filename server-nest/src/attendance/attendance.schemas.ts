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

export const dateRangeQuerySchema = z.object({ fromDate: z.iso.date(), toDate: z.iso.date() });
export type DateRangeDto = z.infer<typeof dateRangeQuerySchema>;

export const staffListingQuerySchema = z.object({ includeDeleted: z.string().optional() });
export type StaffListingQueryDto = z.infer<typeof staffListingQuerySchema>;

export const locationsCursorQuerySchema = z.object({ cursor: z.coerce.number().int().min(0).default(0) });
export type LocationsCursorQueryDto = z.infer<typeof locationsCursorQuerySchema>;

export const managerAttendanceListQuerySchema = z.object({
  month: z.string(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().min(0).default(0),
  shopId: z.string().optional(),
  workerId: z.string().optional(),
});
export type ManagerAttendanceListQueryDto = z.infer<typeof managerAttendanceListQuerySchema>;

export const managerAttendanceSummaryQuerySchema = z.object({
  month: z.string(),
  shopId: z.string().optional(),
  workerId: z.string().optional(),
});
export type ManagerAttendanceSummaryQueryDto = z.infer<typeof managerAttendanceSummaryQuerySchema>;
