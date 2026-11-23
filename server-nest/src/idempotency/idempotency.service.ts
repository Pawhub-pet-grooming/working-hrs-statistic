import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { apiError } from '../common/api-error.js';
import type { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class IdempotencyService {
  /** Mirrors the legacy `idem()` helper: replays a stored response for a repeated operationId, rejects a reused one submitted with different data. */
  async run<T>(
    tx: Prisma.TransactionClient,
    actorAccountId: string,
    operationId: string,
    type: string,
    body: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    const digest = createHash('sha256').update(JSON.stringify({ type, body })).digest('hex');

    await this.lockActorOperations(tx, actorAccountId);

    const existing = await tx.api_operations.findUnique({
      where: { actor_account_id_operation_id: { actor_account_id: actorAccountId, operation_id: operationId } },
    });
    if (existing) {
      if (existing.request_hash !== digest) {
        throw apiError(409, 'Operation ID already used with different data', 'IDEMPOTENCY_CONFLICT');
      }
      return existing.response_data as T;
    }

    const op = await tx.api_operations.create({
      data: { actor_account_id: actorAccountId, operation_id: operationId, request_hash: digest },
    });

    const data = await fn();
    await tx.api_operations.update({ where: { id: op.id }, data: { response_data: data as Prisma.InputJsonValue } });

    return data;
  }

  private async lockActorOperations(tx: Prisma.TransactionClient, actorAccountId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actorAccountId}))`;
  }
}
