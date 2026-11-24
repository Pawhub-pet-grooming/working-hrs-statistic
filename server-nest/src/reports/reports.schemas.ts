import { z } from 'zod';

export const reportPdfSchema = z.object({
  operationId: z.string().uuid(),
  month: z.string(),
  shopId: z.string().optional(),
  workerId: z.string().optional(),
  reportType: z.enum(['ATTENDANCE', 'TIMESHEET']),
});
export type ReportPdfDto = z.infer<typeof reportPdfSchema>;
