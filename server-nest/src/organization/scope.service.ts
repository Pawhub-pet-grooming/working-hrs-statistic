import { Injectable } from '@nestjs/common';
import type { Account } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import type { DbService } from '../database/db.service.js';
import type { Prisma } from '../generated/prisma/client.js';

type Queryable = DbService | Prisma.TransactionClient;

const COMPANY_ADMIN_ROLES = ['GENERAL_MANAGER', 'SUPER_MANAGER'];

/**
 * Mirrors legacy's `allowed`/`assertShop` shop-scope checks (server/src/app.js), shared across
 * business-domain modules (Me, Organization, Attendance, Photos, ...).
 */
@Injectable()
export class ScopeService {
  async allowed(c: Queryable, account: Account, shopId: string): Promise<boolean> {
    if (COMPANY_ADMIN_ROLES.includes(account.role)) return true;
    if (account.role === 'SHOP') {
      return (await c.shops.count({ where: { id: shopId, account_id: account.id } })) > 0;
    }
    return (await c.account_shops.count({ where: { shop_id: shopId, account_id: account.id } })) > 0;
  }

  async assertShop(c: Queryable, account: Account, shopId: string): Promise<void> {
    if (!(await this.allowed(c, account, shopId))) throw apiError(403, 'Shop outside your scope', 'SHOP_FORBIDDEN');
  }
}
