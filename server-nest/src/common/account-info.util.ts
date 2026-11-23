import type { Account } from '../auth/types.js';
import type { Queryable } from '../database/db.service.js';

/** Mirrors legacy's `accountInfo()` (server/src/app.js) — shared by MeModule and OrganizationModule's managed-account routes. */
export async function accountInfo(account: Account, c: Queryable): Promise<Record<string, unknown>> {
  let preferredLoginCode: string | null = null;
  if (account.preferred_shop_id) {
    const [row] = await queryShopLoginCode(c, account.preferred_shop_id);
    preferredLoginCode = row?.login_code ?? null;
  }

  return {
    id: account.id,
    accountId: account.login_code || null,
    role: account.role,
    name: account.name,
    attendanceEnabled: account.status === 'ACTIVE',
    preferredShopId: preferredLoginCode,
  };
}

/** Mirrors legacy's `profileInfo()` (server/src/app.js). */
export async function profileInfo(account: Account, c: Queryable): Promise<Record<string, unknown>> {
  return {
    ...(await accountInfo(account, c)),
    email: account.email || '',
    firstName: account.first_name || account.name,
    lastName: account.last_name || '',
    address: account.profile_address,
    phone: account.profile_phone,
    version: account.profile_version,
  };
}

async function queryShopLoginCode(c: Queryable, shopId: string): Promise<{ login_code: string | null }[]> {
  return c.$queryRaw<
    { login_code: string | null }[]
  >`SELECT sa.login_code FROM shops s JOIN accounts sa ON sa.id=s.account_id WHERE s.id=${shopId}`;
}
