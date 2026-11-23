import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { AuditService } from '../audit/audit.service.js';
import { SHOP_LOGIN_PASSWORD } from '../auth/password.util.js';
import { BACKEND_ROLES, type Account, type Role } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import { DbService, type Queryable } from '../database/db.service.js';
import { GeocodeService } from '../geocode/geocode.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { Coordinates } from '../geocode/geocode.service.js';
import { ScopeService } from './scope.service.js';
import type { CreateShopDto, ShopProfileDto } from './shops.schemas.js';

interface ShopRow {
  id: string;
  account_id: string;
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  profile_version: number;
  shopId: string;
}

interface EmployeeLookupRow {
  workerId: string;
  name: string;
  requires_manager_approval: boolean;
  approved_at: Date | null;
}

/** Mirrors legacy's shops listing/creation/profile routes (server/src/app.js, server/src/organization.js). */
@Injectable()
export class ShopsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly scope: ScopeService,
    private readonly geocode: GeocodeService,
  ) {}

  /** `unrestrictedShopsPath` mirrors legacy's `req.path === "/api/v1/shops"` check — that plain path
   *  returns every shop to backend roles, while `/manager/shops` scopes it to the manager's shops. */
  async list(account: Account, unrestrictedShopsPath: boolean): Promise<ShopRow[]> {
    if (account.role === 'SHOP') {
      return this.queryShopsOwnedByAccount(account.id);
    }

    if (account.role === 'WORKER' || (unrestrictedShopsPath && BACKEND_ROLES.includes(account.role as Role))) {
      return this.queryAllShops();
    }

    return this.queryShopsScopedToManager(account.role, account.id);
  }

  private async queryShopsOwnedByAccount(accountId: string): Promise<ShopRow[]> {
    return this.db.$queryRaw<ShopRow[]>`
      SELECT s.*,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id
      WHERE s.account_id=${accountId}::uuid`;
  }

  private async queryAllShops(): Promise<ShopRow[]> {
    return this.db.$queryRaw<ShopRow[]>`SELECT s.*,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id`;
  }

  private async queryShopsScopedToManager(role: string, accountId: string): Promise<ShopRow[]> {
    return this.db.$queryRaw<ShopRow[]>`
      SELECT s.*,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id
      WHERE ${role} IN('SUPER_MANAGER','GENERAL_MANAGER')
         OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=${accountId}::uuid)`;
  }

  /** Mirrors legacy's `GET /shops/:shopId/employees/:workerId` — a SHOP account looking up one of its employees before clocking them in. */
  async lookupEmployee(account: Account, shopLoginCode: string, workerLoginCode: string): Promise<Record<string, unknown>> {
    const shop = await this.shopIdByLoginCode(shopLoginCode);
    if (!shop) throw apiError(404, 'Shop not found');

    await this.scope.assertShop(this.db, account, shop.id);

    const worker = await this.queryActiveEmployeeByLoginCode(workerLoginCode);
    if (!worker) throw apiError(404, 'Employee not found', 'EMPLOYEE_NOT_FOUND');
    if (worker.requires_manager_approval && !worker.approved_at) {
      throw apiError(403, 'Manager approval required', 'MANAGER_APPROVAL_REQUIRED');
    }

    return { shopId: shopLoginCode, workerId: worker.workerId, name: worker.name };
  }

  async create(account: Account, dto: CreateShopDto): Promise<ShopRow> {
    const passwordHash = await argon2.hash(SHOP_LOGIN_PASSWORD);
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'SHOP_CREATE', dto, async () => {
        const coordinates =
          dto.latitude !== undefined && dto.longitude !== undefined
            ? { latitude: dto.latitude, longitude: dto.longitude }
            : await this.geocode.geocodeAddress(dto.address);

        const [created] = await this.insertShopAccount(tx, dto.shopId, dto.name, passwordHash);

        const [shop] = await this.insertShop(tx, created!.id, dto.name, dto.address, coordinates);

        await this.audit.record(tx, account.id, 'SHOP_CREATE', shop!.id);

        return shop!;
      }),
    );
  }

  async updateProfile(account: Account, id: string, dto: ShopProfileDto): Promise<{ id: string; version: number }> {
    await this.scope.assertShop(this.db, account, id);
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'SHOP_PROFILE', { ...dto, id }, async () => {
        await this.scope.assertShop(tx, account, id);

        const [shop] = await this.queryShopForUpdate(tx, id);
        if (!shop) throw apiError(404, 'Store not found');
        if (shop.profile_version !== dto.expectedVersion) throw apiError(409, 'Store changed; reload');

        const coordinates =
          dto.address === shop.address
            ? { latitude: shop.latitude, longitude: shop.longitude }
            : await this.geocode.geocodeAddress(dto.address);

        await this.updateShopFields(tx, id, dto.name, dto.address, coordinates);

        await tx.accounts.update({ where: { id: shop.account_id }, data: { name: dto.name } });

        await this.audit.record(
          tx,
          account.id,
          'SHOP_PROFILE_CHANGED',
          id,
          { name: shop.name, address: shop.address },
          dto,
        );

        return { id, version: shop.profile_version + 1 };
      }),
    );
  }

  private async insertShopAccount(
    tx: Queryable,
    shopId: string,
    name: string,
    passwordHash: string,
  ): Promise<{ id: string }[]> {
    return tx.$queryRaw<{ id: string }[]>`
      INSERT INTO accounts(role,login_code,name,password_hash,status) VALUES('SHOP',${shopId},${name},${passwordHash},'ACTIVE')
      RETURNING id`;
  }

  private async insertShop(
    tx: Queryable,
    accountId: string,
    name: string,
    address: string,
    coordinates: Coordinates,
  ): Promise<ShopRow[]> {
    return tx.$queryRaw<ShopRow[]>`
      INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES(${accountId}::uuid,${name},${address},${coordinates.latitude},${coordinates.longitude})
      RETURNING *`;
  }

  private async shopIdByLoginCode(loginCode: string): Promise<{ id: string } | null> {
    const [shop] = await this.queryShopIdByLoginCode(loginCode);
    return shop ?? null;
  }

  private async queryShopIdByLoginCode(loginCode: string): Promise<{ id: string }[]> {
    return this.db.$queryRaw<{ id: string }[]>`SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=${loginCode}`;
  }

  private async queryActiveEmployeeByLoginCode(loginCode: string): Promise<EmployeeLookupRow | undefined> {
    const [worker] = await this.db.$queryRaw<EmployeeLookupRow[]>`
      SELECT a.login_code AS "workerId",a.name,a.requires_manager_approval,a.approved_at
      FROM workers w JOIN accounts a ON a.id=w.account_id
      WHERE a.login_code=${loginCode} AND a.role IN('WORKER','MANAGER') AND a.status='ACTIVE'`;
    return worker;
  }

  private async queryShopForUpdate(tx: Queryable, id: string): Promise<ShopRow[]> {
    return tx.$queryRaw<ShopRow[]>`SELECT * FROM shops WHERE id=${id}::uuid FOR UPDATE`;
  }

  private async updateShopFields(
    tx: Queryable,
    id: string,
    name: string,
    address: string,
    coordinates: { latitude: number | string; longitude: number | string },
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE shops SET name=${name}, address=${address}, latitude=${coordinates.latitude}, longitude=${coordinates.longitude}, profile_version=profile_version+1
      WHERE id=${id}::uuid`;
  }
}
