import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import { decryptMailPayload } from '../auth/mail-payload.util.js';
import { DbService } from '../database/db.service.js';
import type { Env } from '../config/env.schema.js';

interface EmailJobRow {
  id: string;
  account_id: string | null;
  password_link_id: string | null;
  recipient_email: string;
  encrypted_payload: string | null;
  attempt_count: number;
  kind: string;
}

interface PasswordLinkRow {
  used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
}

interface AccountStatusCodeRow {
  status: string;
  login_code: string | null;
}

/** Mirrors legacy's `server/src/mail.js`: the `email_jobs` queue drain (password-link + account-approved emails). */
@Injectable()
export class MailService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Mirrors legacy's `processMail()`: claims one queued/stale-leased job, decrypts its payload, and sends it.
   * Reads SMTP config straight from `process.env`, not `ConfigService` — `SMTP_SECURE`'s validated default
   * (`false`) would collapse legacy's "unset means auto-secure on port 465" heuristic.
   */
  async processNextJob(transport?: Transporter): Promise<void> {
    if (
      !transport &&
      (!process.env.SMTP_HOST || !process.env.MAIL_FROM || !process.env.WEB_ORIGIN || !process.env.MAIL_ENCRYPTION_KEY)
    )
      return;

    const job = await this.claimNextJob();
    if (!job) return;

    try {
      if (job.kind !== 'ACCOUNT_APPROVED' && !(await this.passwordLinkStillValid(job.password_link_id))) {
        await this.cancel(job.id);
        return;
      }

      const payload = decryptMailPayload(
        job.encrypted_payload!,
        this.config.get('MAIL_ENCRYPTION_KEY', { infer: true }),
      ) as { name: string; employeeCode?: string | null; role?: string; token?: string };

      let subject: string;
      let text: string;
      if (job.kind === 'ACCOUNT_APPROVED') {
        const account = await this.queryAccountForApproval(job.account_id!);
        if (!account || account.status !== 'ACTIVE' || account.login_code !== payload.employeeCode) {
          await this.cancel(job.id);
          return;
        }

        const label =
          payload.role === 'GENERAL_MANAGER' ? 'General manager' : payload.role === 'MANAGER' ? 'Manager' : 'Groomer';
        subject =
          'Pawhub registration confirmed' +
          (payload.employeeCode ? ' - employee ID ' + payload.employeeCode : ' - ' + label);
        text = `Hello ${payload.name},\nYour Pawhub registration has been approved.\nRole: ${label}\n${
          payload.employeeCode ? 'Your employee ID: ' + payload.employeeCode + '\n' : ''
        }Sign in with your registered email and the password you already set.\n\n您的注册已确认，账号已激活。\n角色：${label}\n${
          payload.employeeCode ? '您的四位员工号：' + payload.employeeCode + '\n' : ''
        }请使用注册邮箱和自行设置的密码登录。`;
      } else {
        const url = new URL(process.env.WEB_ORIGIN!);
        url.hash = 'activate=' + payload.token;
        subject = 'Pawhub account invitation';
        text = `Hello ${payload.name},\nSet your password: ${url}\nThis link expires in seven days and can be used once.`;
      }

      await (transport ?? this.createTransport()).sendMail({
        from: process.env.MAIL_FROM,
        to: job.recipient_email,
        subject,
        text,
        messageId: `<pawhub-${job.id}@pawhub.local>`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      await this.db
        .$executeRaw`UPDATE email_jobs SET status='SENT',sent_at=now(),encrypted_payload=NULL WHERE id=${job.id}::uuid`;
    } catch (e) {
      const err = e as { code?: string; name?: string };
      const status = job.attempt_count >= 4 ? 'FAILED' : 'QUEUED';
      await this.db.$executeRaw`
        UPDATE email_jobs
        SET status=${status},last_error_code=${err.code ?? err.name ?? null},next_attempt_at=now()+interval '5 minutes',
            encrypted_payload=CASE WHEN ${status}='FAILED' THEN NULL ELSE encrypted_payload END
        WHERE id=${job.id}::uuid`;
    }
  }

  private async claimNextJob(): Promise<EmailJobRow | null> {
    return this.db.$transaction(async (tx) => {
      const [job] = await tx.$queryRaw<EmailJobRow[]>`
        SELECT * FROM email_jobs
        WHERE (status='QUEUED' AND next_attempt_at<=now()) OR (status='PROCESSING' AND lease_expires_at<now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!job) return null;

      await tx.$executeRaw`
        UPDATE email_jobs SET status='PROCESSING',attempt_count=attempt_count+1,lease_expires_at=now()+interval '5 minutes'
        WHERE id=${job.id}::uuid`;
      return job;
    });
  }

  private async passwordLinkStillValid(passwordLinkId: string | null): Promise<boolean> {
    const [link] = await this.db.$queryRaw<
      PasswordLinkRow[]
    >`SELECT * FROM password_links WHERE id=${passwordLinkId}::uuid`;
    return !!link && !link.used_at && !link.revoked_at && new Date(link.expires_at) > new Date();
  }

  private async queryAccountForApproval(accountId: string): Promise<AccountStatusCodeRow | undefined> {
    const [account] = await this.db.$queryRaw<AccountStatusCodeRow[]>`
      SELECT status,login_code FROM accounts WHERE id=${accountId}::uuid`;
    return account;
  }

  private async cancel(jobId: string): Promise<void> {
    await this.db.$executeRaw`UPDATE email_jobs SET status='CANCELLED',encrypted_payload=NULL WHERE id=${jobId}::uuid`;
  }

  private createTransport(): Transporter {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === 'true' || (process.env.SMTP_SECURE === undefined && port === 465);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      requireTLS: !secure,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
  }
}
