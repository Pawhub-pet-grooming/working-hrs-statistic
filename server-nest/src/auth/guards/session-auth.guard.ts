import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { apiError } from '../../common/api-error.js';
import { DbService } from '../../database/db.service.js';

/**
 * Replaces the legacy `app.use("/api/v1", ...)` session middleware: validates the bearer
 * token against the `sessions` table and attaches the account, mirroring its ACTIVE /
 * WORKER-pending-approval eligibility rule exactly.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw apiError(401, 'Please sign in');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const session = await this.db.sessions.findFirst({
      where: {
        token_hash: tokenHash,
        revoked_at: null,
        expires_at: { gt: new Date() },
        accounts: {
          OR: [
            { status: 'ACTIVE' },
            { role: 'WORKER', status: 'PENDING', requires_manager_approval: true, password_hash: { not: null } },
          ],
        },
      },
      include: { accounts: true },
    });
    if (!session) throw apiError(401, 'Session expired');
    req.account = session.accounts;
    req.sessionHash = tokenHash;
    return true;
  }
}
