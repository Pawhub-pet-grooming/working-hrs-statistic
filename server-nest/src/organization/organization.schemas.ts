import { z } from 'zod';

const uuid = z.string().uuid();

export const permissionsSchema = z
  .object({
    operationId: uuid,
    expectedVersion: z.number().int().positive(),
    managerId: uuid,
    shopIds: z.array(uuid).max(100),
    workerIds: z.array(uuid).max(9000),
  })
  .strict();
export type PermissionsDto = z.infer<typeof permissionsSchema>;

export const generalManagerSchema = z
  .object({ operationId: uuid, expectedVersion: z.number().int().positive(), accountId: uuid })
  .strict();
export type GeneralManagerDto = z.infer<typeof generalManagerSchema>;

export const roleChangeSchema = z
  .object({
    operationId: uuid,
    expectedVersion: z.number().int().positive(),
    accountId: uuid,
    role: z.enum(['MANAGER', 'WORKER']),
  })
  .strict();
export type RoleChangeDto = z.infer<typeof roleChangeSchema>;
