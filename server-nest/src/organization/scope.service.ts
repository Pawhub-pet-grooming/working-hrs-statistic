import { Injectable } from '@nestjs/common';
import { BACKEND_ROLES, type Account, type Role } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import type { DbService } from '../database/db.service.js';
import type { Prisma } from '../generated/prisma/client.js';

type Queryable = DbService | Prisma.TransactionClient;

const COMPANY_ADMIN_ROLES = ['GENERAL_MANAGER', 'SUPER_MANAGER'];

/**
 * Mirrors legacy's `allowed`/`assertShop`/`assertWorker` scope checks (server/src/app.js), shared
 * across business-domain modules (Me, Organization, Attendance, Photos, ...).
 */
@Injectable()
export class ScopeService {
  /** Mirrors legacy's `companyAdmin()`. */
  isCompanyAdmin(account: Account): boolean {
    return COMPANY_ADMIN_ROLES.includes(account.role);
  }

  async allowed(c: Queryable, account: Account, shopId: string): Promise<boolean> {
    if (this.isCompanyAdmin(account)) return true;
    if (account.role === 'SHOP') {
      return (await c.shops.count({ where: { id: shopId, account_id: account.id } })) > 0;
    }
    return (await c.account_shops.count({ where: { shop_id: shopId, account_id: account.id } })) > 0;
  }

  async assertShop(c: Queryable, account: Account, shopId: string): Promise<void> {
    if (!(await this.allowed(c, account, shopId))) throw apiError(403, 'Shop outside your scope', 'SHOP_FORBIDDEN');
  }

  async assertWorker(c: Queryable, account: Account, workerId: string): Promise<void> {
    if (this.isCompanyAdmin(account)) return;
    const count = await c.manager_workers.count({ where: { manager_account_id: account.id, worker_id: workerId } });
    if (!count) throw apiError(403, 'Groomer outside your scope', 'WORKER_FORBIDDEN');
  }

  /** Mirrors legacy's `assertRecordScope()` — an attendance record is in scope if the shop or the worker is. */
  async assertRecordScope(c: Queryable, account: Account, shopId: string, workerId: string): Promise<void> {
    if (BACKEND_ROLES.includes(account.role as Role)) {
      const ownWorker = await c.workers.count({ where: { id: workerId, account_id: account.id } });
      if (ownWorker) return;
    }

    if (await this.allowed(c, account, shopId)) return;

    await this.assertWorker(c, account, workerId);
  }
}
