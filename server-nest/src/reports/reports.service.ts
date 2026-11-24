import { Injectable } from '@nestjs/common';
import { ATTENDANCE_ZONE, monthBounds } from '../attendance/attendance-domain.util.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import type { Account } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import { DbService } from '../database/db.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { ScopeService } from '../organization/scope.service.js';
import type { ReportPdfDto } from './reports.schemas.js';
import { DateTime } from 'luxon';
import PDFDocument from 'pdfkit';

interface ReportSnapshotRecord {
  workerId: string | null;
  shopId: string | null;
  worker_id: string;
  shop_id: string;
  sign_type: string;
  original_occurred_at: Date;
  confirmed_occurred_at: Date | null;
}

interface ReportSnapshotGroup {
  workerId: string | null;
  shopId: string | null;
  confirmedHrs: string;
  pendingSegmentCount: number;
  invalidSegmentCount: number;
}

interface ReportSnapshot {
  records: ReportSnapshotRecord[];
  groups: ReportSnapshotGroup[];
  period: unknown;
  scopeIds: string[];
}

/** Mirrors legacy's `POST /manager/reports/pdf` (server/src/app.js): `records()`/`summary()` snapshot, stored for audit, rendered as a PDF. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService,
    private readonly attendance: AttendanceService,
    private readonly scope: ScopeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async buildPdf(account: Account, dto: ReportPdfDto): Promise<Buffer> {
    monthBounds(dto.month);

    const snapshot = await this.db.$transaction(
      (tx) =>
        this.idempotency.run(tx, account.id, dto.operationId, 'PDF', dto, async () => {
          const { records, groups, period } = await this.attendance.reportSnapshot(
            tx,
            account,
            dto.month,
            dto.shopId ?? null,
            dto.workerId ?? null,
          );
          const scopeIds = await this.attendance.reportScopeShopIds(tx, account, dto.shopId ?? null);
          const snap: ReportSnapshot = {
            records: records as unknown as ReportSnapshotRecord[],
            groups: groups as unknown as ReportSnapshotGroup[],
            period,
            scopeIds,
          };

          await tx.report_exports.create({
            data: { requested_by_account_id: account.id, filters: dto, snapshot_data: snap as unknown as Prisma.InputJsonValue },
          });

          return snap;
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    for (const record of snapshot.records) {
      await this.scope.assertRecordScope(this.db, account, record.shop_id, record.worker_id);
    }
    for (const group of snapshot.groups) {
      const ids = await this.attendance.resolveWorkerShopIds(group.workerId as string, group.shopId as string);
      if (!ids) throw apiError(403, 'Report scope unavailable');
      await this.scope.assertRecordScope(this.db, account, ids.shop_id, ids.worker_id);
    }

    return this.renderPdf(dto, snapshot);
  }

  private renderPdf(dto: ReportPdfDto, snapshot: ReportSnapshot): Promise<Buffer> {
    return this.pdfToBuffer((doc) => {
      doc.fontSize(18).text(`Pawhub ${dto.reportType} - ${dto.month}`);
      doc.fontSize(10).text('Timezone: Pacific/Auckland. Pending/invalid periods excluded.');
      for (const g of snapshot.groups) {
        doc
          .moveDown()
          .text(`${g.workerId} | ${g.shopId} | ${g.confirmedHrs} hrs | pending ${g.pendingSegmentCount} | errors ${g.invalidSegmentCount}`);
      }
      if (dto.reportType === 'ATTENDANCE') {
        for (const r of snapshot.records) {
          doc
            .moveDown()
            .text(
              `${r.workerId} ${r.shopId} ${r.sign_type}\nOriginal: ${DateTime.fromJSDate(new Date(r.original_occurred_at), { zone: ATTENDANCE_ZONE }).toFormat('yyyy-MM-dd HH:mm:ss')}\nConfirmed: ${
                r.confirmed_occurred_at
                  ? DateTime.fromJSDate(new Date(r.confirmed_occurred_at), { zone: ATTENDANCE_ZONE }).toFormat('yyyy-MM-dd HH:mm:ss')
                  : 'Pending'
              }`,
            );
        }
      }
    });
  }

  private pdfToBuffer(write: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      write(doc);
      doc.end();
    });
  }
}
