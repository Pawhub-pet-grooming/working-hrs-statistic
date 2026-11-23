import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import { randomBytes, createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { apiError } from '../common/api-error.js';
import { DbService } from '../database/db.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Env } from '../config/env.schema.js';
import {
  type ChangePasswordDto,
  type ConsumePasswordLinkDto,
  type LoginDto,
  type RegisterDto,
  type RequestPasswordLinkDto,
} from './auth.schemas.js';
import { encryptMailPayload } from './mail-payload.util.js';
import { passwordMatches } from './password.util.js';
import type { Account } from './types.js';

const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');

function accountInfo(account: Account, preferredLoginCode: string | null): Record<string, unknown> {
  return {
    id: account.id,
    accountId: account.login_code || null,
    role: account.role,
    name: account.name,
    attendanceEnabled: account.status === 'ACTIVE',
    preferredShopId: preferredLoginCode || null,
  };
}

interface PasswordLinkRow {
  id: string;
  account_id: string;
  purpose: string;
  used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  status: string;
  requires_manager_approval: boolean;
  approved_at: Date | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async login(dto: LoginDto, isManager: boolean): Promise<Record<string, unknown>> {
    return this.db.$transaction(async (tx) => {
      const emailParam = dto.email?.toLowerCase();
      const rows = await this.queryLoginCandidates(tx, isManager, emailParam, dto.accountId);

      const matches: Account[] = [];
      for (const account of rows) {
        const eligible =
          account.status === 'ACTIVE' ||
          (!isManager && account.role === 'WORKER' && account.status === 'PENDING' && account.requires_manager_approval);
        if (eligible && (await passwordMatches(account, dto.password))) matches.push(account);
      }

      if (!matches.length) throw apiError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');
      if (matches.length > 1) {
        throw apiError(
          422,
          'Multiple accounts match. Use your four-digit employee ID or contact an administrator.',
          'AMBIGUOUS_ACCOUNT',
        );
      }

      const account = matches[0]!;
      const sessionToken = newToken();
      const expiresAt = new Date(Date.now() + this.config.get('SESSION_HOURS', { infer: true }) * 3600000);

      await tx.sessions.create({
        data: { account_id: account.id, token_hash: sha256Hex(sessionToken), expires_at: expiresAt },
      });

      const preferred = account.preferred_shop_id
        ? await this.queryPreferredShopLoginCode(tx, account.preferred_shop_id)
        : [];

      return { sessionToken, expiresAt, account: accountInfo(account, preferred[0]?.login_code ?? null) };
    });
  }

  async register(dto: RegisterDto): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Shares the employee-code allocation lock (used elsewhere for worker/manager creation)
      // so a concurrent registration and an admin-created account can't race on the same email.
      await this.lockEmployeeCodeAllocation(tx);

      const matches = await this.queryAccountsByEmail(tx, dto.email);
      let account = matches.find((a) => a.role === 'WORKER');
      if (matches.length && (!account || account.status !== 'PENDING')) return;

      if (!account) {
        account = await tx.accounts.create({
          data: { role: 'WORKER', email: dto.email, name: dto.email, requires_manager_approval: true },
        });
        await tx.workers.create({ data: { account_id: account.id, contact: '', address: '' } });
        await this.audit.record(tx, account.id, 'SELF_REGISTRATION', account.id);
      }

      const recent = await this.queryRecentFirstSetupLink(tx, account.id);
      if (!recent.length) await this.invite(tx, account, 'FIRST_SETUP');
    });
  }

  async requestPasswordLink(dto: RequestPasswordLinkDto): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const matches = await this.queryPasswordResetCandidates(tx, dto.accountId, dto.email?.toLowerCase());

      for (const account of matches) await this.invite(tx, account, 'PASSWORD_RESET');
    });
  }

  async consumePasswordLink(dto: ConsumePasswordLinkDto): Promise<Record<string, unknown>> {
    return this.db.$transaction(async (tx) => {
      const tokenHash = sha256Hex(dto.token);
      const rows = await this.queryPasswordLinkByToken(tx, tokenHash);

      const link = rows[0];
      if (
        !link ||
        link.used_at ||
        link.revoked_at ||
        new Date(link.expires_at) <= new Date() ||
        link.status === 'DISABLED' ||
        (link.purpose === 'FIRST_SETUP' && link.status !== 'PENDING') ||
        (link.purpose === 'PASSWORD_RESET' && link.status !== 'ACTIVE')
      ) {
        throw apiError(422, 'Link invalid or expired', 'INVALID_LINK');
      }

      const awaitingManagerApproval = link.requires_manager_approval && !link.approved_at;
      const passwordHash = await argon2.hash(dto.newPassword);

      await tx.accounts.update({
        where: { id: link.account_id },
        data: { password_hash: passwordHash, status: awaitingManagerApproval ? 'PENDING' : 'ACTIVE' },
      });

      await tx.password_links.update({ where: { id: link.id }, data: { used_at: new Date() } });

      await tx.password_links.updateMany({
        where: { account_id: link.account_id, used_at: null, revoked_at: null },
        data: { revoked_at: new Date() },
      });

      await tx.sessions.updateMany({
        where: { account_id: link.account_id, revoked_at: null },
        data: { revoked_at: new Date() },
      });

      return { activated: !awaitingManagerApproval, awaitingManagerApproval };
    });
  }

  async logout(sessionHash: string): Promise<void> {
    await this.db.sessions.updateMany({ where: { token_hash: sessionHash }, data: { revoked_at: new Date() } });
  }

  async changePassword(account: Account, dto: ChangePasswordDto): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const [current] = await this.queryAccountForUpdate(tx, account.id);
      if (!current.password_hash || !(await argon2.verify(current.password_hash, dto.currentPassword))) {
        throw apiError(422, 'Current password is incorrect', 'CURRENT_PASSWORD_INCORRECT');
      }
      if (dto.currentPassword === dto.newPassword) throw apiError(422, 'Choose a different password', 'PASSWORD_UNCHANGED');

      await tx.accounts.update({ where: { id: account.id }, data: { password_hash: await argon2.hash(dto.newPassword) } });
      await tx.sessions.updateMany({ where: { account_id: account.id, revoked_at: null }, data: { revoked_at: new Date() } });

      await tx.password_links.updateMany({
        where: { account_id: account.id, used_at: null, revoked_at: null },
        data: { revoked_at: new Date() },
      });

      await this.audit.record(tx, account.id, 'PASSWORD_CHANGE', account.id);
    });
  }

  /** Also used by OrganizationModule's account-creation/invitation-resend routes. */
  async invite(tx: Prisma.TransactionClient, account: Account, purpose: 'FIRST_SETUP' | 'PASSWORD_RESET'): Promise<string> {
    const t = newToken();

    await tx.password_links.updateMany({
      where: { account_id: account.id, used_at: null, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    await tx.email_jobs.updateMany({
      where: { account_id: account.id, kind: 'PASSWORD_LINK', status: { in: ['QUEUED', 'FAILED'] } },
      data: { status: 'CANCELLED', encrypted_payload: null },
    });

    const link = await tx.password_links.create({
      data: {
        account_id: account.id,
        purpose,
        token_hash: sha256Hex(t),
        expires_at: new Date(Date.now() + 7 * 86400000),
      },
    });

    const payload = encryptMailPayload({ token: t, name: account.name }, this.config.get('MAIL_ENCRYPTION_KEY', { infer: true }));

    await tx.email_jobs.create({
      data: {
        account_id: account.id,
        password_link_id: link.id,
        recipient_email: account.email as string,
        encrypted_payload: payload,
      },
    });

    return link.id;
  }

  private async queryLoginCandidates(
    tx: Prisma.TransactionClient,
    isManager: boolean,
    emailParam: string | undefined,
    accountId: string | undefined,
  ): Promise<Account[]> {
    return isManager
      ? emailParam
        ? tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE lower(email)=${emailParam} AND role IN('MANAGER','GENERAL_MANAGER','SUPER_MANAGER') ORDER BY id FOR SHARE`
        : tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE login_code=${accountId} AND role IN('MANAGER','GENERAL_MANAGER','SUPER_MANAGER') ORDER BY id FOR SHARE`
      : emailParam
        ? tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE lower(email)=${emailParam} AND role IN('WORKER','MANAGER','GENERAL_MANAGER','SUPER_MANAGER') ORDER BY id FOR SHARE`
        : tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE login_code=${accountId} AND role IN('SHOP','WORKER','MANAGER','GENERAL_MANAGER') FOR SHARE`;
  }

  private async queryPreferredShopLoginCode(
    tx: Prisma.TransactionClient,
    shopId: string,
  ): Promise<{ login_code: string }[]> {
    return tx.$queryRaw<{ login_code: string }[]>`SELECT sa.login_code FROM shops s JOIN accounts sa ON sa.id = s.account_id WHERE s.id = ${shopId}`;
  }

  private async lockEmployeeCodeAllocation(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(820013)`;
  }

  private async queryAccountsByEmail(tx: Prisma.TransactionClient, email: string): Promise<Account[]> {
    return tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE lower(email) = ${email} ORDER BY id FOR UPDATE`;
  }

  private async queryRecentFirstSetupLink(tx: Prisma.TransactionClient, accountId: string): Promise<unknown[]> {
    return tx.$queryRaw<unknown[]>`SELECT 1 FROM password_links WHERE account_id = ${accountId} AND purpose = 'FIRST_SETUP' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() + interval '6 days 23 hours 55 minutes'`;
  }

  private async queryPasswordResetCandidates(
    tx: Prisma.TransactionClient,
    accountId: string | undefined,
    email: string | undefined,
  ): Promise<Account[]> {
    return accountId
      ? tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE login_code = ${accountId} AND role IN('WORKER','MANAGER','GENERAL_MANAGER') AND status = 'ACTIVE' ORDER BY id FOR UPDATE`
      : tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE lower(email) = ${email} AND role IN('WORKER','MANAGER','GENERAL_MANAGER','SUPER_MANAGER') AND status = 'ACTIVE' ORDER BY id FOR UPDATE`;
  }

  private async queryPasswordLinkByToken(tx: Prisma.TransactionClient, tokenHash: string): Promise<PasswordLinkRow[]> {
    return tx.$queryRaw<PasswordLinkRow[]>`SELECT p.*, a.status, a.requires_manager_approval, a.approved_at FROM password_links p JOIN accounts a ON a.id = p.account_id WHERE p.token_hash = ${tokenHash} FOR UPDATE OF p, a`;
  }

  private async queryAccountForUpdate(tx: Prisma.TransactionClient, accountId: string): Promise<Account[]> {
    return tx.$queryRaw<Account[]>`SELECT * FROM accounts WHERE id = ${accountId} FOR UPDATE`;
  }
}
