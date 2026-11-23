import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PERSONAL_ROLES, type Account, type Role } from '../auth/types.js';
import { accountInfo, profileInfo } from '../common/account-info.util.js';
import { apiError } from '../common/api-error.js';
import { DbService, type Queryable } from '../database/db.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { ScopeService } from '../organization/scope.service.js';
import type { PreferencesDto, ProfileDto } from './me.schemas.js';

/** Mirrors legacy's `/api/v1/me*` routes (server/src/app.js). */
@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly scope: ScopeService,
  ) {}

  async info(account: Account): Promise<Record<string, unknown>> {
    return accountInfo(account, this.db);
  }

  async stores(account: Account): Promise<unknown[]> {
    if (!PERSONAL_ROLES.includes(account.role as Role)) throw apiError(403, 'Personal account required');

    return this.queryAllShopsForPersonalAccount();
  }

  async profile(account: Account): Promise<Record<string, unknown>> {
    return profileInfo(account, this.db);
  }

  async updatePreferences(account: Account, dto: PreferencesDto): Promise<Record<string, unknown>> {
    return this.db.$transaction(async (tx) => {
      let shopId: string | null = null;
      if (dto.preferredShopId !== null) {
        const shop = await this.shopByLoginCode(tx, dto.preferredShopId);
        if (!shop) throw apiError(422, 'Unknown preferred shop');
        if (!PERSONAL_ROLES.includes(account.role as Role)) await this.scope.assertShop(tx, account, shop.id);
        shopId = shop.id;
      }

      await tx.accounts.update({
        where: { id: account.id },
        data: { preferred_shop_id: shopId, profile_version: { increment: 1 } },
      });

      return { preferredShopId: dto.preferredShopId };
    });
  }

  async updateProfile(account: Account, dto: ProfileDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'PROFILE', dto, async () => {
        const [previous] = await this.queryAccountForUpdate(tx, account.id);
        if (previous!.profile_version !== dto.expectedVersion) {
          throw apiError(409, 'Profile changed; reload before saving', 'PROFILE_CHANGED');
        }

        let preferred: { id: string } | null = null;
        if (dto.preferredShopId !== null) {
          preferred = await this.shopByLoginCode(tx, dto.preferredShopId);
          if (!preferred) throw apiError(422, 'Unknown preferred shop');
          if (!PERSONAL_ROLES.includes(account.role as Role)) await this.scope.assertShop(tx, account, preferred.id);
        }

        const name = [dto.firstName, dto.lastName].filter(Boolean).join(' ');
        const [updated] = await this.updateAccountProfile(tx, account.id, dto, name, preferred?.id ?? null);

        await tx.workers.updateMany({
          where: { account_id: account.id },
          data: { address: dto.address, contact: dto.phone },
        });

        await this.audit.record(
          tx,
          account.id,
          'PROFILE_UPDATE',
          account.id,
          {
            firstName: previous!.first_name,
            lastName: previous!.last_name,
            address: previous!.profile_address,
            phone: previous!.profile_phone,
            preferredShopId: previous!.preferred_shop_id,
          },
          {
            firstName: dto.firstName,
            lastName: dto.lastName,
            address: dto.address,
            phone: dto.phone,
            preferredShopId: preferred?.id ?? null,
          },
        );

        return profileInfo(updated!, tx);
      }),
    );
  }

  private async shopByLoginCode(c: Queryable, loginCode: string): Promise<{ id: string } | null> {
    const [shop] = await c.$queryRaw<
      { id: string }[]
    >`SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=${loginCode}`;
    return shop ?? null;
  }

  private async queryAllShopsForPersonalAccount(): Promise<unknown[]> {
    return this.db.$queryRaw<
      unknown[]
    >`SELECT s.id,s.name,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id ORDER BY s.name`;
  }

  private async queryAccountForUpdate(tx: Queryable, accountId: string): Promise<Account[]> {
    return tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE id=${accountId} FOR UPDATE`;
  }

  private async updateAccountProfile(
    tx: Queryable,
    accountId: string,
    dto: ProfileDto,
    name: string,
    preferredShopId: string | null,
  ): Promise<Account[]> {
    return tx.$queryRaw<Account[]>`
      UPDATE accounts SET first_name=${dto.firstName}, last_name=${dto.lastName}, profile_address=${dto.address},
        profile_phone=${dto.phone}, name=${name}, preferred_shop_id=${preferredShopId}, profile_version=profile_version+1
      WHERE id=${accountId} RETURNING *`;
  }
}
