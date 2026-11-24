import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service.js';
import { encryptMailPayload } from '../auth/mail-payload.util.js';
import type { Account } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import type { Env } from '../config/env.schema.js';
import { DbService } from '../database/db.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { AccountsService } from './accounts.service.js';
import type { GeneralManagerDto, PermissionsDto, RoleChangeDto } from './organization.schemas.js';

interface PersonRow {
  id: string;
  role: string;
  name: string;
  email: string | null;
  status: string;
  employeeCode: string | null;
  passwordSet: boolean;
  workerId: string | null;
}

interface ShopRow {
  id: string;
  name: string;
  code: string | null;
}

interface AssignmentRow {
  managerId: string;
  shopIds: string[];
  workerIds: string[];
}

const EMPLOYEE_CODE_PATTERN = /^[1-9][0-9]{3}$/;

/** Mirrors legacy's org-wide routes (server/src/organization.js): singleton org state, manager permissions, GM appointment, role changes. */
@Injectable()
export class OrganizationService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly accounts: AccountsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getState(): Promise<Record<string, unknown>> {
    return this.db.$transaction(async (tx) => {
      await this.setRepeatableRead(tx);

      const [people, shops, assignments, version] = await Promise.all([
        this.queryPeople(tx),
        this.queryShops(tx),
        this.queryAssignments(tx),
        this.queryVersion(tx),
      ]);

      return { people, shops, assignments, version };
    });
  }

  async setPermissions(account: Account, dto: PermissionsDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'ORGANIZATION_PERMISSIONS', dto, async () => {
        await this.checkRevision(tx, dto.expectedVersion);

        const manager = await this.lockManager(tx, dto.managerId);
        if (!manager || manager.role !== 'MANAGER' || manager.status === 'DISABLED')
          throw apiError(422, 'Choose a manager');

        const shopIds = [...new Set(dto.shopIds)];
        const workerIds = [...new Set(dto.workerIds)];

        const matchedShops = await this.countShopsById(tx, shopIds);
        if (matchedShops !== shopIds.length) throw apiError(422, 'Unknown store');

        const matchedWorkers = await this.countWorkerAccountsById(tx, workerIds);
        if (matchedWorkers !== workerIds.length) throw apiError(422, 'Unknown groomer');

        await this.replaceShopAssignments(tx, dto.managerId, shopIds);
        await this.replaceWorkerAssignments(tx, dto.managerId, workerIds);

        return this.finishMutation(tx, account, 'MANAGER_PERMISSIONS_CHANGED', dto.managerId, {
          managerId: dto.managerId,
          shopIds,
          workerIds,
        });
      }),
    );
  }

  async appointGeneralManager(account: Account, dto: GeneralManagerDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'GENERAL_MANAGER_APPOINTMENT', dto, async () => {
        await this.checkRevision(tx, dto.expectedVersion);

        const person = await this.lockPerson(tx, dto.accountId);
        const eligible =
          person &&
          ['MANAGER', 'GENERAL_MANAGER'].includes(person.role) &&
          person.status !== 'DISABLED' &&
          person.password_hash;
        if (!eligible) throw apiError(422, 'The selected manager must set a password first');

        const demoted = await this.demoteExistingGeneralManagers(tx, person!.id);

        await this.promoteToGeneralManager(tx, person!.id, account.id);

        await this.revokeSessions(tx, [person!.id, ...demoted.map((row) => row.id)]);

        if (person!.status === 'PENDING') await this.queueGeneralManagerApprovalEmail(tx, person!);

        return this.finishMutation(tx, account, 'GENERAL_MANAGER_APPOINTED', person!.id, { accountId: person!.id });
      }),
    );
  }

  async changeRole(account: Account, dto: RoleChangeDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'ORGANIZATION_ROLE', dto, async () => {
        await this.checkRevision(tx, dto.expectedVersion);

        await this.lockEmployeeCodeAllocation(tx);

        const person = await this.lockPerson(tx, dto.accountId);
        if (!person || !['MANAGER', 'WORKER'].includes(person.role) || person.status === 'DISABLED') {
          throw apiError(422, 'Choose a manager or groomer');
        }

        let code = person.login_code;
        const needsCode = !code || !EMPLOYEE_CODE_PATTERN.test(code);
        if (needsCode && (person.status === 'ACTIVE' || dto.role === 'MANAGER'))
          code = await this.accounts.allocateEmployeeCode(tx);

        if (dto.role === 'WORKER') {
          if (person.status !== 'ACTIVE' && code && !EMPLOYEE_CODE_PATTERN.test(code)) code = null;

          await this.ensureWorkerRow(tx, person.id, person.profile_phone, person.profile_address);
          await this.clearManagerAssignments(tx, person.id);
        } else {
          await this.clearWorkerManagerLinks(tx, person.id);
        }

        await this.applyRoleChange(tx, person.id, dto.role, code);

        await this.revokeSessions(tx, [person.id]);

        return this.finishMutation(tx, account, 'PERSON_ROLE_CHANGED', person.id, {
          accountId: person.id,
          role: dto.role,
        });
      }),
    );
  }

  private async finishMutation(
    tx: Prisma.TransactionClient,
    actor: Account,
    action: string,
    resourceId: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const version = await this.bumpVersion(tx);

    await this.audit.record(tx, actor.id, action, resourceId, null, data);

    return { ...data, version };
  }

  private async checkRevision(tx: Prisma.TransactionClient, expectedVersion: number): Promise<void> {
    const [row] = await this.lockOrganizationVersion(tx);
    if (row!.version !== expectedVersion) throw apiError(409, 'Organization changed; reload before saving');
  }

  private async bumpVersion(tx: Prisma.TransactionClient): Promise<number> {
    const [row] = await this.incrementOrganizationVersion(tx);
    return row!.version;
  }

  private async queueGeneralManagerApprovalEmail(tx: Prisma.TransactionClient, person: Account): Promise<void> {
    const payload = encryptMailPayload(
      { name: person.name, role: 'GENERAL_MANAGER', employeeCode: person.login_code },
      this.config.get('MAIL_ENCRYPTION_KEY', { infer: true }),
    );

    await tx.email_jobs.create({
      data: {
        account_id: person.id,
        recipient_email: person.email as string,
        encrypted_payload: payload,
        kind: 'ACCOUNT_APPROVED',
      },
    });
  }

  private async setRepeatableRead(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
  }

  private async queryPeople(tx: Prisma.TransactionClient): Promise<PersonRow[]> {
    return tx.$queryRaw<PersonRow[]>`
      SELECT a.id,a.role,a.name,a.email,a.status,a.login_code AS "employeeCode",(a.password_hash IS NOT NULL) AS "passwordSet",w.id AS "workerId"
      FROM accounts a LEFT JOIN workers w ON w.account_id=a.id
      WHERE a.role IN('WORKER','MANAGER','GENERAL_MANAGER') ORDER BY a.name`;
  }

  private async queryShops(tx: Prisma.TransactionClient): Promise<ShopRow[]> {
    return tx.$queryRaw<
      ShopRow[]
    >`SELECT s.id,s.name,a.login_code AS code FROM shops s JOIN accounts a ON a.id=s.account_id ORDER BY s.name`;
  }

  private async queryAssignments(tx: Prisma.TransactionClient): Promise<AssignmentRow[]> {
    return tx.$queryRaw<AssignmentRow[]>`
      SELECT a.id AS "managerId",ARRAY(SELECT shop_id FROM account_shops WHERE account_id=a.id) AS "shopIds",
        ARRAY(SELECT worker_id FROM manager_workers WHERE manager_account_id=a.id) AS "workerIds"
      FROM accounts a WHERE a.role='MANAGER' AND a.status<>'DISABLED'`;
  }

  private async queryVersion(tx: Prisma.TransactionClient): Promise<number> {
    const [row] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM organization_state WHERE id=true`;
    return row!.version;
  }

  private async lockOrganizationVersion(tx: Prisma.TransactionClient): Promise<{ version: number }[]> {
    return tx.$queryRaw<{ version: number }[]>`SELECT version FROM organization_state WHERE id=true FOR UPDATE`;
  }

  private async incrementOrganizationVersion(tx: Prisma.TransactionClient): Promise<{ version: number }[]> {
    return tx.$queryRaw<
      { version: number }[]
    >`UPDATE organization_state SET version=version+1 WHERE id=true RETURNING version`;
  }

  private async lockManager(tx: Prisma.TransactionClient, managerId: string): Promise<Account | undefined> {
    const [manager] = await tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE id=${managerId}::uuid FOR UPDATE`;
    return manager;
  }

  private async lockPerson(tx: Prisma.TransactionClient, accountId: string): Promise<Account | undefined> {
    const [person] = await tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE id=${accountId}::uuid FOR UPDATE`;
    return person;
  }

  private async countShopsById(tx: Prisma.TransactionClient, shopIds: string[]): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM shops WHERE id=ANY(${shopIds}::uuid[])`;
    return rows.length;
  }

  private async countWorkerAccountsById(tx: Prisma.TransactionClient, workerIds: string[]): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT w.id FROM workers w JOIN accounts a ON a.id=w.account_id WHERE w.id=ANY(${workerIds}::uuid[]) AND a.role='WORKER'`;
    return rows.length;
  }

  private async replaceShopAssignments(
    tx: Prisma.TransactionClient,
    managerId: string,
    shopIds: string[],
  ): Promise<void> {
    await tx.$executeRaw`DELETE FROM account_shops WHERE account_id=${managerId}::uuid`;
    await tx.$executeRaw`INSERT INTO account_shops(account_id,shop_id) SELECT ${managerId}::uuid,unnest(${shopIds}::uuid[])`;
  }

  private async replaceWorkerAssignments(
    tx: Prisma.TransactionClient,
    managerId: string,
    workerIds: string[],
  ): Promise<void> {
    await tx.$executeRaw`DELETE FROM manager_workers WHERE manager_account_id=${managerId}::uuid`;
    await tx.$executeRaw`INSERT INTO manager_workers(manager_account_id,worker_id) SELECT ${managerId}::uuid,unnest(${workerIds}::uuid[])`;
  }

  private async demoteExistingGeneralManagers(
    tx: Prisma.TransactionClient,
    exceptAccountId: string,
  ): Promise<{ id: string }[]> {
    return tx.$queryRaw<{ id: string }[]>`
      UPDATE accounts SET role='MANAGER' WHERE role='GENERAL_MANAGER' AND id<>${exceptAccountId}::uuid RETURNING id`;
  }

  private async promoteToGeneralManager(
    tx: Prisma.TransactionClient,
    accountId: string,
    approvedByAccountId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE accounts SET role='GENERAL_MANAGER',status='ACTIVE',approved_at=COALESCE(approved_at,now()),
        approved_by_account_id=COALESCE(approved_by_account_id,${approvedByAccountId}::uuid) WHERE id=${accountId}::uuid`;
  }

  private async revokeSessions(tx: Prisma.TransactionClient, accountIds: string[]): Promise<void> {
    await tx.$executeRaw`UPDATE sessions SET revoked_at=now() WHERE account_id=ANY(${accountIds}::uuid[]) AND revoked_at IS NULL`;
  }

  private async lockEmployeeCodeAllocation(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(820013)`;
  }

  private async ensureWorkerRow(
    tx: Prisma.TransactionClient,
    accountId: string,
    contact: string | null,
    address: string | null,
  ): Promise<void> {
    await tx.$executeRaw`INSERT INTO workers(account_id,contact,address) VALUES(${accountId}::uuid,${contact},${address}) ON CONFLICT(account_id) DO NOTHING`;
  }

  private async clearManagerAssignments(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
    await tx.$executeRaw`DELETE FROM account_shops WHERE account_id=${accountId}::uuid`;
    await tx.$executeRaw`DELETE FROM manager_workers WHERE manager_account_id=${accountId}::uuid`;
  }

  private async clearWorkerManagerLinks(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
    await tx.$executeRaw`DELETE FROM manager_workers WHERE worker_id IN(SELECT id FROM workers WHERE account_id=${accountId}::uuid)`;
  }

  private async applyRoleChange(
    tx: Prisma.TransactionClient,
    accountId: string,
    role: 'MANAGER' | 'WORKER',
    loginCode: string | null,
  ): Promise<void> {
    await tx.$executeRaw`UPDATE accounts SET role=${role},login_code=${loginCode},profile_version=profile_version+1 WHERE id=${accountId}::uuid`;
  }
}
