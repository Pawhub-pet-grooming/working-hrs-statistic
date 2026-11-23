import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { encryptMailPayload } from '../auth/mail-payload.util.js';
import type { Account } from '../auth/types.js';
import { profileInfo } from '../common/account-info.util.js';
import { apiError } from '../common/api-error.js';
import type { Env } from '../config/env.schema.js';
import { DbService } from '../database/db.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { ScopeService } from './scope.service.js';
import type {
  ApproveAccountDto,
  CreateAccountDto,
  ManagedProfileDto,
  RemoveAccountDto,
  ResendInvitationDto,
} from './accounts.schemas.js';

interface WorkerDirectoryRow {
  id: string;
  accountId: string;
  workerId: string | null;
  name: string;
  email: string | null;
  status: string;
  requires_manager_approval: boolean;
  password_set: boolean;
  firstName: string;
  lastName: string;
  address: string;
  phone: string;
  version: number;
  preferredShopId: string | null;
}

interface ManagerDirectoryRow {
  accountId: string;
  role: string;
  name: string;
  email: string | null;
  status: string;
  employeeCode: string | null;
  requires_manager_approval: boolean;
  password_set: boolean;
  firstName: string;
  lastName: string;
  address: string;
  phone: string;
  version: number;
  preferredShopId: string | null;
}

interface InvitationRow {
  id: string;
  accountId: string;
  name: string;
  status: string | null;
  last_error_code: string | null;
  created_at: Date | null;
  expires_at: Date;
  used_at: Date | null;
}

/** Mirrors legacy's workers/managers directory, account-creation, and managed-account routes (server/src/app.js). */
@Injectable()
export class AccountsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly scope: ScopeService,
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async listWorkers(account: Account): Promise<WorkerDirectoryRow[]> {
    return this.db.$queryRaw<WorkerDirectoryRow[]>`
      SELECT w.id,a.id AS "accountId",a.login_code AS "workerId",a.name,a.email,a.status,a.requires_manager_approval,
        (a.password_hash IS NOT NULL) AS password_set,a.first_name AS "firstName",a.last_name AS "lastName",
        a.profile_address AS address,a.profile_phone AS phone,a.profile_version AS version,sa.login_code AS "preferredShopId"
      FROM workers w JOIN accounts a ON a.id=w.account_id
      LEFT JOIN shops ps ON ps.id=a.preferred_shop_id LEFT JOIN accounts sa ON sa.id=ps.account_id
      WHERE a.role='WORKER' AND (${account.role} IN('SUPER_MANAGER','GENERAL_MANAGER')
        OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=${account.id}::uuid AND mw.worker_id=w.id))
      ORDER BY a.name`;
  }

  async listManagers(): Promise<ManagerDirectoryRow[]> {
    return this.db.$queryRaw<ManagerDirectoryRow[]>`
      SELECT a.id AS "accountId",a.role,a.name,a.email,a.status,a.login_code AS "employeeCode",a.requires_manager_approval,
        (a.password_hash IS NOT NULL) AS password_set,a.first_name AS "firstName",a.last_name AS "lastName",
        a.profile_address AS address,a.profile_phone AS phone,a.profile_version AS version,sa.login_code AS "preferredShopId"
      FROM accounts a LEFT JOIN shops ps ON ps.id=a.preferred_shop_id LEFT JOIN accounts sa ON sa.id=ps.account_id
      WHERE a.role IN('MANAGER','GENERAL_MANAGER') ORDER BY a.name`;
  }

  async listInvitations(account: Account): Promise<InvitationRow[]> {
    return this.db.$queryRaw<InvitationRow[]>`
      SELECT e.id,e.account_id AS "accountId",a.name,e.status,e.last_error_code,e.created_at,p.expires_at,p.used_at
      FROM email_jobs e JOIN accounts a ON a.id=e.account_id JOIN password_links p ON p.id=e.password_link_id
      WHERE ${account.role} IN('SUPER_MANAGER','GENERAL_MANAGER')
         OR EXISTS(SELECT 1 FROM workers w JOIN manager_workers mw ON mw.worker_id=w.id WHERE w.account_id=a.id AND mw.manager_account_id=${account.id}::uuid)
      ORDER BY e.created_at DESC LIMIT 100`;
  }

  async create(account: Account, dto: CreateAccountDto, isManager: boolean): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'ACCOUNT_CREATE', dto, async () => {
        const shopIds: string[] = [];
        for (const code of isManager ? [...new Set(dto.shopIds)] : []) {
          const shop = await this.shopByLoginCode(tx, code);
          if (!shop) throw apiError(422, 'Shop not found');
          await this.scope.assertShop(tx, account, shop.id);
          shopIds.push(shop.id);
        }
        let preferred: { id: string } | null = null;
        if (dto.preferredShopId) {
          preferred = await this.shopByLoginCode(tx, dto.preferredShopId);
          if (!preferred) throw apiError(422, 'Unknown preferred shop');
          if (isManager) await this.scope.assertShop(tx, account, preferred.id);
        }
        const firstName = dto.firstName || dto.name;
        const lastName = dto.lastName || '';
        const name = [firstName, lastName].filter(Boolean).join(' ');
        const code = await this.allocateEmployeeCode(tx);
        const requiresManagerApproval = account.role !== 'SUPER_MANAGER';
        const created = await tx.accounts.create({
          data: {
            role: isManager ? 'MANAGER' : 'WORKER',
            login_code: code,
            email: dto.email.toLowerCase(),
            name,
            first_name: firstName,
            last_name: lastName,
            profile_address: dto.address || '',
            profile_phone: dto.phone ?? dto.contact ?? '',
            preferred_shop_id: preferred?.id ?? null,
            requires_manager_approval: requiresManagerApproval,
            approved_by_account_id: requiresManagerApproval ? null : account.id,
            approved_at: requiresManagerApproval ? null : new Date(),
          },
        });
        const worker = await tx.workers.create({
          data: { account_id: created.id, contact: dto.phone ?? dto.contact ?? '', address: dto.address || '' },
        });
        if (shopIds.length) {
          await tx.account_shops.createMany({ data: shopIds.map((shopId) => ({ account_id: created.id, shop_id: shopId })) });
        }
        if (!isManager && account.role === 'MANAGER') {
          await tx.manager_workers.createMany({
            data: [{ manager_account_id: account.id, worker_id: worker.id }],
            skipDuplicates: true,
          });
        }
        const invitationId = await this.auth.invite(tx, created, 'FIRST_SETUP');
        await this.audit.record(tx, account.id, 'ACCOUNT_CREATE', created.id);
        return {
          accountId: created.id,
          workerId: code,
          activationStatus: 'PENDING',
          requiresManagerApproval,
          invitationId,
          emailStatus: 'QUEUED',
        };
      }),
    );
  }

  async updateManagedProfile(account: Account, accountId: string, dto: ManagedProfileDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'MANAGED_PROFILE', { ...dto, accountId }, async () => {
        const person = await this.managedPerson(tx, account, accountId);
        if (person.status === 'DISABLED') throw apiError(409, 'Account has been deleted');
        if (person.profile_version !== dto.expectedVersion) throw apiError(409, 'Profile changed; reload before saving', 'PROFILE_CHANGED');
        let preferred: { id: string } | null = null;
        if (dto.preferredShopId) {
          preferred = await this.shopByLoginCode(tx, dto.preferredShopId);
          if (!preferred) throw apiError(422, 'Unknown preferred shop');
          if (person.role === 'MANAGER') await this.scope.assertShop(tx, account, preferred.id);
        }
        const name = [dto.firstName, dto.lastName].filter(Boolean).join(' ');
        const updated = await tx.accounts.update({
          where: { id: accountId },
          data: {
            first_name: dto.firstName,
            last_name: dto.lastName,
            name,
            profile_address: dto.address,
            profile_phone: dto.phone,
            preferred_shop_id: preferred?.id ?? null,
            profile_version: { increment: 1 },
          },
        });
        await tx.workers.updateMany({ where: { account_id: accountId }, data: { address: dto.address, contact: dto.phone } });
        await this.audit.record(
          tx,
          account.id,
          'MANAGED_PROFILE_UPDATE',
          accountId,
          {
            name: person.name,
            address: person.profile_address,
            phone: person.profile_phone,
            preferredShopId: person.preferred_shop_id,
          },
          { name: updated.name, address: dto.address, phone: dto.phone, preferredShopId: preferred?.id ?? null },
        );
        return profileInfo(updated, tx);
      }),
    );
  }

  async remove(account: Account, accountId: string, dto: RemoveAccountDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'PERSON_REMOVE', { ...dto, accountId }, async () => {
        const person = await this.managedPerson(tx, account, accountId);
        if (person.id === account.id) throw apiError(403, 'You cannot delete your own account');
        if (person.profile_version !== dto.expectedVersion || person.status === 'DISABLED') {
          throw apiError(409, 'Account changed; reload');
        }
        await tx.accounts.update({ where: { id: accountId }, data: { status: 'DISABLED', profile_version: { increment: 1 } } });
        await tx.sessions.updateMany({ where: { account_id: accountId, revoked_at: null }, data: { revoked_at: new Date() } });
        await tx.password_links.updateMany({ where: { account_id: accountId, used_at: null }, data: { revoked_at: new Date() } });
        await tx.email_jobs.updateMany({
          where: { account_id: accountId, status: { in: ['QUEUED', 'FAILED'] } },
          data: { status: 'CANCELLED', encrypted_payload: null },
        });
        await tx.attendance_export_jobs.updateMany({
          where: { account_id: accountId, status: 'QUEUED' },
          data: { status: 'FAILED', last_error_code: 'ACCOUNT_DISABLED' },
        });
        await this.audit.record(tx, account.id, 'PERSON_REMOVED', accountId, { status: person.status }, { status: 'DISABLED' });
        return { accountId, status: 'DISABLED' };
      }),
    );
  }

  async approve(account: Account, accountId: string, dto: ApproveAccountDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'ACCOUNT_APPROVAL', { ...dto, accountId }, async () => {
        const [target] = await tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE id=${accountId}::uuid FOR UPDATE`;
        if (!target || !['WORKER', 'MANAGER'].includes(target.role)) throw apiError(404, 'Personnel account missing');
        if (target.status !== 'PENDING' || !target.requires_manager_approval) throw apiError(409, 'Account is not awaiting approval');
        if (!target.password_hash) throw apiError(409, 'Employee must set a password first');
        const employeeCode =
          target.role === 'WORKER' ? target.login_code || (await this.allocateEmployeeCode(tx)) : target.login_code;
        await tx.accounts.update({
          where: { id: accountId },
          data: { status: 'ACTIVE', login_code: employeeCode, approved_by_account_id: account.id, approved_at: new Date() },
        });
        await tx.email_jobs.create({
          data: {
            account_id: accountId,
            recipient_email: target.email as string,
            encrypted_payload: encryptMailPayload(
              { name: target.name, employeeCode, role: target.role },
              this.config.get('MAIL_ENCRYPTION_KEY', { infer: true }),
            ),
            kind: 'ACCOUNT_APPROVED',
          },
        });
        await this.audit.record(
          tx,
          account.id,
          'ACCOUNT_APPROVED',
          accountId,
          { status: 'PENDING', employeeCode: null },
          { status: 'ACTIVE', employeeCode },
        );
        return { accountId, workerId: employeeCode, status: 'ACTIVE', emailStatus: 'QUEUED' };
      }),
    );
  }

  async resendInvitation(account: Account, accountId: string, dto: ResendInvitationDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'INVITATION', { ...dto, accountId }, async () => {
        const [target] = await tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE id=${accountId}::uuid FOR UPDATE`;
        if (!target || target.status !== 'PENDING') throw apiError(422, 'Only pending accounts can be invited');
        if (!this.scope.isCompanyAdmin(account) && target.role !== 'WORKER') throw apiError(403, 'Owner required');
        if (!this.scope.isCompanyAdmin(account)) {
          const [worker] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM workers WHERE account_id=${target.id}::uuid`;
          await this.scope.assertWorker(tx, account, worker!.id);
        }
        const invitationId = await this.auth.invite(tx, target, 'FIRST_SETUP');
        await this.audit.record(tx, account.id, 'INVITATION_RESEND', target.id);
        return { invitationId, emailStatus: 'QUEUED' };
      }),
    );
  }

  private async managedPerson(tx: Prisma.TransactionClient, actor: Account, accountId: string): Promise<Account> {
    const [person] = await tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE id=${accountId}::uuid FOR UPDATE`;
    if (!person || !['WORKER', 'MANAGER'].includes(person.role)) throw apiError(404, 'Person not found');
    if (person.role === 'MANAGER' && !this.scope.isCompanyAdmin(actor)) throw apiError(403, 'Only owner can manage managers');
    if (person.role === 'WORKER') {
      const [worker] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM workers WHERE account_id=${person.id}::uuid`;
      await this.scope.assertWorker(tx, actor, worker!.id);
    }
    return person;
  }

  /** Mirrors legacy's advisory-locked scan for an unused 4-digit employee code (`pg_advisory_xact_lock(820013)`). */
  private async allocateEmployeeCode(tx: Prisma.TransactionClient): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(820013)`;
    const used = new Set(
      (await tx.$queryRaw<{ login_code: string }[]>`SELECT login_code FROM accounts WHERE login_code ~ '^[1-9][0-9]{3}$'`).map(
        (r) => r.login_code,
      ),
    );
    const available: string[] = [];
    for (let i = 1000; i <= 9999; i++) if (!used.has(String(i))) available.push(String(i));
    if (!available.length) throw apiError(409, 'Employee IDs exhausted');
    return available[randomInt(available.length)]!;
  }

  private async shopByLoginCode(c: Prisma.TransactionClient, loginCode: string): Promise<{ id: string } | null> {
    const [shop] = await c.$queryRaw<
      { id: string }[]
    >`SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=${loginCode}`;
    return shop ?? null;
  }
}
