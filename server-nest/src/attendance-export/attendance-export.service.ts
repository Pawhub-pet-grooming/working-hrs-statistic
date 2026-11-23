import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import nodemailer, { type Transporter } from 'nodemailer';
import PDFDocument from 'pdfkit';
import { ATTENDANCE_ZONE } from '../attendance/attendance-domain.util.js';
import { dailyAttendanceHours, totalAttendanceHours, type AttendanceHoursRecord } from '../attendance/attendance-hours.util.js';
import { DbService } from '../database/db.service.js';

const CJK_FONT_PATH = new URL('../../../server/assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url).pathname;

export interface AttendanceExportRecord extends AttendanceHoursRecord {
  worker_id: string;
  worker_name: string;
  shop_name: string;
  original_occurred_at: string | Date;
  confirmed_occurred_at?: string | Date | null;
  manager_confirmed?: boolean;
}

export interface AttendanceExportSnapshot {
  shopName: string;
  fromDate: string;
  toDate: string;
  workerName: string;
  workerCode?: string | null;
  staffMode: boolean;
  dailyHours?: ReturnType<typeof dailyAttendanceHours>;
  records: AttendanceExportRecord[];
}

interface ExportJobRow {
  id: string;
  account_id: string;
  recipient_email: string;
  subject: string;
  snapshot_data: AttendanceExportSnapshot;
  attempt_count: number;
}

interface AccountRoleStatusRow {
  role: string;
  status: string;
}

interface WorkerIdRow {
  worker_id: string;
}

interface ShopIdRow {
  shop_id: string;
}

const STAFF_SCOPE_ROLES = ['MANAGER', 'GENERAL_MANAGER', 'SUPER_MANAGER'];

/** Mirrors legacy's `server/src/attendance-export.js`: PDF rendering + the `attendance_export_jobs` queue drain. */
@Injectable()
export class AttendanceExportService {
  constructor(private readonly db: DbService) {}

  /** Mirrors legacy's `attendancePdf()`. */
  async buildPdf(snapshot: AttendanceExportSnapshot): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 32, size: 'A4', layout: 'landscape', bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.font(CJK_FONT_PATH);
      const width = doc.page.width - 64;
      let y = 0;

      function pageHeader(): void {
        doc.fillColor('#182433').fontSize(17).text('Pawhub attendance / 签到记录', 32, 28, { width });
        doc
          .fontSize(9)
          .text(`${snapshot.workerName}${snapshot.workerCode ? ` (${snapshot.workerCode})` : ''} · ${snapshot.shopName}`, 32, 56, { width });
        y = doc.y + 5;
        doc.fillColor('#667382').text(`${snapshot.fromDate} — ${snapshot.toDate}  |  Pacific/Auckland`, 32, y, { width });
        y = doc.y + 18;
      }
      pageHeader();

      function table(title: string, headers: string[], weights: number[], rows: unknown[][]): void {
        const widths = weights.map((w) => (width * w) / weights.reduce((a, b) => a + b, 0));
        function row(cells: unknown[], header = false, index = 0, total = false): void {
          doc.fontSize(header ? 8 : 9);
          const height = Math.max(30, ...cells.map((cell, i) => doc.heightOfString(String(cell), { width: widths[i]! - 16 }) + 16));
          if (y + height > doc.page.height - 40) {
            doc.addPage();
            pageHeader();
            if (!header) row(headers, true);
          }
          doc.rect(32, y, width, height).fill(header || total ? '#e9eef5' : index % 2 ? '#f6f8fb' : '#ffffff');
          let x = 32;
          cells.forEach((cell, i) => {
            doc.fillColor('#182433').fontSize(header ? 8 : 9).text(String(cell), x + 8, y + 8, { width: widths[i]! - 16 });
            x += widths[i]!;
          });
          doc.moveTo(32, y + height).lineTo(32 + width, y + height).strokeColor('#dce1e7').lineWidth(0.5).stroke();
          y += height;
        }
        if (y + 95 > doc.page.height - 40) {
          doc.addPage();
          pageHeader();
        }
        doc.fillColor('#182433').fontSize(12).text(title, 32, y, { width });
        y = doc.y + 8;
        row(headers, true);
        rows.forEach((cells, index) => row(cells, false, index, title.startsWith('Daily') && index === rows.length - 1));
        y += 22;
      }

      const days = snapshot.dailyHours ?? dailyAttendanceHours(snapshot.records);
      const total = totalAttendanceHours(days);
      const hours = (day: { valid: boolean; hours: string | null }): string =>
        day.valid ? (day.hours as string) : 'Adjust attendance records / 需要调整签到记录';
      const pending = (day: { pending: boolean }): string => (day.pending ? 'Changes awaiting manager confirmation / 待 Manager 确认修改' : '—');
      table(
        'Daily working hours / 每日工作小时',
        [...(snapshot.staffMode ? ['Staff / 员工'] : []), 'Shop / 门店', 'Date / 日期', 'Working hours / 工作小时', 'Status / 状态'],
        snapshot.staffMode ? [1.5, 1.5, 1, 2, 3] : [1.5, 1, 2, 3],
        [
          ...days.map((day) => [
            ...(snapshot.staffMode ? [(day as { workerName?: string }).workerName] : []),
            (day as { shopName?: string }).shopName || snapshot.shopName,
            day.date,
            hours(day),
            pending(day),
          ]),
          [...(snapshot.staffMode ? ['—'] : []), 'Total hours / 总计工时', '—', hours(total), pending(total)],
        ],
      );

      const time = (value: string | Date | null | undefined): string =>
        value ? DateTime.fromISO(value instanceof Date ? value.toISOString() : value).setZone(ATTENDANCE_ZONE).toFormat('dd/MM/yyyy HH:mm') : '—';
      const records = [...snapshot.records].sort(
        (a, b) => +new Date(a.effective_occurred_at) - +new Date(b.effective_occurred_at) || String(a.id).localeCompare(String(b.id)),
      );
      table(
        'Attendance records / 签到明细',
        [
          ...(snapshot.staffMode ? ['Staff / 员工'] : []),
          'Store / 门店',
          'Type / 类型',
          'Original / 原始时间',
          'Current / 当前时间',
          'Confirmed / 确认时间',
          'Status / 状态',
        ],
        snapshot.staffMode ? [1.2, 1.3, 1, 1.5, 1.5, 1.5, 1.6] : [1.5, 1, 1.5, 1.5, 1.5, 1.6],
        records.map((r) => [
          ...(snapshot.staffMode ? [r.worker_name] : []),
          r.shop_name || snapshot.shopName,
          (r.pending_sign_type || r.sign_type) === 'SIGN_IN' ? 'Clock in / 上班' : 'Clock out / 下班',
          time(r.original_occurred_at),
          time(r.effective_occurred_at),
          time(r.manager_confirmed ? r.confirmed_occurred_at : null),
          r.pending
            ? r.effective_deleted
              ? 'Removal pending / 删除待确认'
              : 'Pending approval / 待确认'
            : r.manager_confirmed
              ? 'Confirmed / 已确认'
              : 'Submitted / 已提交',
        ]),
      );

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc
          .fillColor('#667382')
          .fontSize(8)
          .text(`${i + 1} / ${range.count}`, 32, doc.page.height - 26, { width, align: 'right', lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    });
  }

  /**
   * Mirrors legacy's `processAttendanceExports()`: claims one queued/stale-leased job and sends it.
   * Reads SMTP config straight from `process.env`, not `ConfigService` — `SMTP_SECURE`'s validated
   * default (`false`) would collapse legacy's "unset means auto-secure on port 465" heuristic.
   */
  async processNextJob(transport?: Transporter): Promise<void> {
    if (!transport && (!process.env.SMTP_HOST || !process.env.MAIL_FROM)) return;

    const job = await this.claimNextJob();
    if (!job) return;

    try {
      if (job.snapshot_data.staffMode) await this.assertExportScopeStillValid(job);

      const pdf = await this.buildPdf(job.snapshot_data);
      await (transport ?? this.createTransport()).sendMail({
        from: process.env.MAIL_FROM,
        to: job.recipient_email,
        subject: job.subject,
        messageId: `<attendance-${job.id}@pawhub.local>`,
        text: `Your queried attendance records are attached.\nStore: ${job.snapshot_data.shopName}\nPeriod: ${job.snapshot_data.fromDate} - ${job.snapshot_data.toDate}\nTimezone: Pacific/Auckland`,
        attachments: [
          {
            filename: `Pawhub-attendance-${job.snapshot_data.fromDate}-${job.snapshot_data.toDate}.pdf`,
            content: pdf,
            contentType: 'application/pdf',
          },
        ],
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      await this.db.$executeRaw`UPDATE attendance_export_jobs SET status='SENT',sent_at=now(),lease_expires_at=NULL WHERE id=${job.id}::uuid`;
    } catch (e) {
      const err = e as { code?: string; name?: string };
      const status = job.attempt_count >= 4 || err.code === 'STAFF_SCOPE_REVOKED' ? 'FAILED' : 'QUEUED';
      await this.db.$executeRaw`
        UPDATE attendance_export_jobs
        SET status=${status},last_error_code=${err.code ?? err.name ?? null},next_attempt_at=now()+interval '5 minutes',lease_expires_at=NULL
        WHERE id=${job.id}::uuid`;
    }
  }

  private async claimNextJob(): Promise<ExportJobRow | null> {
    return this.db.$transaction(async (tx) => {
      const [job] = await tx.$queryRaw<ExportJobRow[]>`
        SELECT * FROM attendance_export_jobs
        WHERE (status='QUEUED' AND next_attempt_at<=now()) OR (status='PROCESSING' AND lease_expires_at<now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!job) return null;

      await tx.$executeRaw`
        UPDATE attendance_export_jobs
        SET status='PROCESSING',attempt_count=attempt_count+1,lease_expires_at=now()+interval '5 minutes'
        WHERE id=${job.id}::uuid`;
      return job;
    });
  }

  private async assertExportScopeStillValid(job: ExportJobRow): Promise<void> {
    const [account] = await this.db.$queryRaw<AccountRoleStatusRow[]>`SELECT role,status FROM accounts WHERE id=${job.account_id}::uuid`;
    if (!account || account.status !== 'ACTIVE' || !STAFF_SCOPE_ROLES.includes(account.role)) {
      throw Object.assign(new Error('Export scope revoked'), { code: 'STAFF_SCOPE_REVOKED' });
    }
    if (account.role !== 'MANAGER') return;

    const permittedRows = await this.db.$queryRaw<WorkerIdRow[]>`
      SELECT worker_id FROM manager_workers WHERE manager_account_id=${job.account_id}::uuid
      UNION SELECT id AS worker_id FROM workers WHERE account_id=${job.account_id}::uuid`;
    const shopRows = await this.db.$queryRaw<ShopIdRow[]>`SELECT shop_id FROM account_shops WHERE account_id=${job.account_id}::uuid`;

    const permitted = new Set(permittedRows.map((r) => r.worker_id));
    const shops = new Set(shopRows.map((r) => r.shop_id));
    if (job.snapshot_data.records.some((r) => !permitted.has(r.worker_id) && !shops.has(r.shop_id ?? ''))) {
      throw Object.assign(new Error('Export scope revoked'), { code: 'STAFF_SCOPE_REVOKED' });
    }
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
