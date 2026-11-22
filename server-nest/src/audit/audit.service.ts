import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class AuditService {
  async record(
    tx: Prisma.TransactionClient,
    actorAccountId: string,
    action: string,
    resourceId: string | null,
    before: unknown = null,
    after: unknown = null,
  ): Promise<void> {
    await tx.audit_logs.create({
      data: {
        actor_account_id: actorAccountId,
        action,
        resource_id: resourceId,
        before_data: before === null ? Prisma.DbNull : (before as Prisma.InputJsonValue),
        after_data: after === null ? Prisma.DbNull : (after as Prisma.InputJsonValue),
      },
    });
  }
}
