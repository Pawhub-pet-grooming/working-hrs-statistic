import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { BACKEND_ROLES, PERSONAL_ROLES, type Account, type Role } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import { DbService, type Queryable } from '../database/db.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { ScopeService } from '../organization/scope.service.js';
import { ATTENDANCE_ZONE, localDate, monthBounds, type MonthBounds } from './attendance-domain.util.js';
import { dailyAttendanceHours, totalAttendanceHours, type AttendanceHoursRecord, type DailyHours } from './attendance-hours.util.js';
import { attendanceLocation, type AttendanceLocationInput } from './attendance-location.util.js';
import type {
  AdjustmentDto,
  ClockDto,
  CorrectionDto,
  DateRangeDto,
  DecisionDto,
  ManagerAttendanceListQueryDto,
  ManagerAttendanceSummaryQueryDto,
} from './attendance.schemas.js';

const SHOP_CODE_PATTERN = /^00\d{2}$/;
const WORKER_CODE_PATTERN = /^(?:[1-9]\d{3}|__self__|__worker__[a-f0-9-]{36})$/;

/** Shape of a repeated or comma-joined query param (`?x=a&x=b` or `?x=a,b`) before `selectedCodes` parses it. */
type CodeQueryValue = string | string[] | undefined;

/** Express's query parser only ever produces string, string[], or undefined for a query param. */
function asCodeQueryValue(value: unknown): CodeQueryValue {
  return value as CodeQueryValue;
}

interface AppScopeWorkerRow {
  id: string;
  account_id: string;
  account_status: string;
}

interface AppScopeShopRow {
  id: string;
  name: string;
  latitude: string;
  longitude: string;
}

interface ClockWorkerRow {
  id: string;
  account_id: string;
}

interface ClockShopRow {
  id: string;
  name: string;
  latitude: string;
  longitude: string;
}

interface AttendanceRecordRow {
  id: string;
  original_occurred_at: Date;
  sign_type: string;
}

interface RebuildRecordRow {
  id: string;
  shop_id: string;
  sign_type: string;
  original_occurred_at: Date;
  confirmed_occurred_at: Date | null;
  pending: boolean;
}

interface AttendanceScope {
  shopIds: string[] | null;
  s: { name: string; id: string | null } | null;
  workerIds: string[];
  staffName?: string;
  staffCode?: string | null;
}

interface AvailableStaffRow {
  id: string;
  account_id: string;
  name: string;
  login_code: string | null;
  /** Absent on rows added via `queryAdditionalWorkersByCode` — only read when `includeDeleted` falls back to the primary query's rows. */
  status?: string;
}

interface AdditionalStaffRow {
  id: string;
  account_id: string;
  name: string;
  login_code: string | null;
}

interface StoreRow {
  id: string;
  name: string;
}

interface StaffListingRow {
  id: string;
  name: string;
  workerId: string;
  status: string;
}

interface AttendanceListingRow extends AttendanceHoursRecord {
  worker_id: string;
  shop_id: string;
  worker_name: string;
  worker_code: string | null;
  shop_name: string;
  shop_code: string | null;
}

interface AttendanceDaySummary extends DailyHours {
  workerId: string;
  workerCode: string;
  workerName: string;
  shopId: string;
  shopCode: string | null;
  shopName: string;
}

interface LocationRow {
  id: string;
  photo_id: string | null;
  worker_id: string;
  shop_id: string;
  original_occurred_at: Date;
  effective_occurred_at: Date;
  confirmed_occurred_at: Date | null;
  manager_confirmed: boolean;
  sign_type: string;
  location: AttendanceLocationInput | null;
  worker_name: string;
  worker_code: string | null;
  shop_name: string;
  shop_latitude: string;
  shop_longitude: string;
}

interface StoreListRow {
  id: string;
  name: string;
  shopId: string;
}

interface GroomerListRow {
  id: string;
  accountId: string;
  name: string;
  workerId: string;
  status: string;
}

interface ManagerAttendanceRecordRow {
  id: string;
  worker_id: string;
  shop_id: string;
  workerId: string | null;
  shopId: string | null;
}

interface ManagerSummaryGroupRow {
  workerId: string | null;
  worker_name: string;
  shopId: string | null;
  shop_name: string;
  confirmedHrs: string;
  pendingSegmentCount: number;
  invalidSegmentCount: number;
}

interface AdjustmentRecordRow {
  id: string;
  worker_id: string;
  shop_id: string;
  sign_type: string;
  version: number;
  confirmed_occurred_at: Date | null;
  confirmed_deleted: boolean;
  manager_confirmed: boolean;
  effective_occurred_at: Date;
}

interface AdjustmentWorkerLoadRow extends AdjustmentRecordRow {
  worker_code: string | null;
  shop_code: string | null;
}

interface PendingAdjustmentRow {
  id: string;
  after_type: string | null;
}

interface AdjustmentIdRow {
  id: string;
}

interface AdjustmentWorkerLookupRow {
  id: string;
}

interface WorkerAccountIdRow {
  account_id: string;
}

interface AdjustmentHistoryRow {
  id: string;
  record_id: string;
  decision: string | null;
  validated_at: Date | null;
  validator: string | null;
}

interface AdjustmentQueueRow {
  id: string;
  item_type: string;
}

interface IssueQueueRow {
  id: string;
  item_type: string;
}

interface PersonApprovalRow {
  account_id: string;
  item_type: string;
}

interface LocationPosition {
  status: string;
  latitude?: number;
  longitude?: number;
  distanceMeters?: number;
  accuracyMeters?: number | null;
  capturedAt?: string | null;
  shopLatitude?: number;
  shopLongitude?: number;
}

/** Mirrors legacy's clock-in/out and status routes (server/src/app.js). */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  async clockInOrOut(account: Account, dto: ClockDto): Promise<Record<string, unknown>> {
    if (!PERSONAL_ROLES.includes(account.role as Role) && account.role !== 'SHOP') throw apiError(403, 'App account required');

    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'ATTENDANCE', dto, async () => {
        const worker = await this.lockActiveWorkerByCode(tx, dto.workerId);
        const shop = await this.shopByCode(tx, dto.shopId);
        if (!worker || !shop) throw apiError(422, 'Unknown worker or shop');

        if (account.role !== 'SHOP') {
          if (worker.account_id !== account.id) throw apiError(403, 'Cannot sign for another worker');
        } else {
          await this.scope.assertShop(tx, account, shop.id);
        }

        if (dto.expectedDailyCount !== undefined) await this.checkDailyCountExpectation(tx, worker.id, shop.id, dto.occurredAt, dto.expectedDailyCount);

        await this.checkPhoto(tx, account, dto);

        if (dto.location?.status === 'AVAILABLE' && (dto.location.latitude === undefined || dto.location.longitude === undefined)) {
          throw apiError(422, 'Coordinates required');
        }

        const position = this.resolvePosition(account, dto, shop);

        const day = localDate(dto.occurredAt);
        const first = !(await this.hasSignInToday(tx, worker.id, day));

        if (dto.type === 'SIGN_OUT' && dto.plannedStartAt) throw apiError(422, 'Sign out cannot include plan');
        if (dto.type === 'SIGN_IN' && first && !dto.plannedStartAt) throw apiError(422, 'First sign in requires planned time');
        if (dto.plannedStartAt && localDate(dto.plannedStartAt) !== day) throw apiError(422, 'Plan must be on sign-in date');

        const record = await this.insertAttendanceRecord(tx, worker.id, shop.id, account, dto, first, position);

        await this.rebuildWorkSegments(tx, worker.id);

        return {
          recordId: record.id,
          shopId: dto.shopId,
          shopName: shop.name,
          occurredAt: record.original_occurred_at,
          type: record.sign_type,
          dailyCount: await this.dailyAttendanceCount(tx, worker.id, shop.id, day),
          syncStatus: 'SYNCED',
          validationStatus: 'SUBMITTED',
        };
      }),
    );
  }

  async status(account: Account, shopCode: string | undefined, workerCode: string | undefined): Promise<Record<string, unknown>> {
    const code = workerCode || account.login_code || undefined;
    const { worker, shop } = await this.resolveAppScope(this.db, account, shopCode, code);

    const day = localDate(new Date());
    const latest = await this.latestRecordToday(this.db, worker.id, shop!.id, day);
    const any = await this.hasSignInToday(this.db, worker.id, day);
    const count = await this.dailyAttendanceCount(this.db, worker.id, shop!.id, day);

    return {
      localDate: day,
      timezone: ATTENDANCE_ZONE,
      attendanceEnabled: account.status === 'ACTIVE',
      serverTime: new Date().toISOString(),
      dailyCount: count,
      requiresPlannedStart: !any,
      latestRecordId: latest?.id ?? null,
    };
  }

  /** Mirrors legacy's `appScope()` — resolves the worker/shop a personal or shop-device request applies to. */
  async resolveAppScope(
    c: Queryable,
    account: Account,
    shopCode: string | null | undefined,
    workerCode: string | null | undefined,
    allowAllShops = false,
  ): Promise<{ worker: AppScopeWorkerRow; shop: AppScopeShopRow | null }> {
    if (BACKEND_ROLES.includes(account.role as Role)) await this.ensureWorkerRow(c, account.id, account.profile_phone, account.profile_address);

    const worker = await this.queryAppScopeWorker(c, workerCode || null, account.id);
    const shop = shopCode ? await this.queryAppScopeShop(c, shopCode) : null;

    if (worker && account.role === 'SHOP' && worker.account_status !== 'ACTIVE') throw apiError(404, 'Active employee required');
    if (!worker || (!shop && !(allowAllShops && !shopCode && account.role !== 'SHOP'))) throw apiError(422, 'Unknown worker or shop');

    if (PERSONAL_ROLES.includes(account.role as Role)) {
      if (worker.account_id !== account.id) throw apiError(403, 'Only your own records');
    } else if (account.role === 'SHOP') {
      await this.scope.assertShop(c, account, shop!.id);
    } else {
      throw apiError(403, 'App account required');
    }

    return { worker, shop: shop ?? null };
  }

  async dailyAttendanceCount(c: Queryable, workerId: string, shopId: string, day: string): Promise<number> {
    const [row] = await this.queryDailyAttendanceCount(c, workerId, shopId, day);
    return row!.count;
  }

  /** Mirrors legacy's `rebuild()` — recomputes every `work_segments` row for a worker from their attendance records, sequentially. */
  async rebuildWorkSegments(tx: Prisma.TransactionClient, workerId: string): Promise<void> {
    await this.lockWorkerForRebuild(tx, workerId);
    await this.deleteWorkSegments(tx, workerId);

    const records = await this.queryRecordsForRebuild(tx, workerId);

    const opens = new Map<string, RebuildRecordRow>();
    const crossShopUnclosed = new Set<string>();

    for (const record of records) {
      const previousOpen = opens.get(record.shop_id);

      if (record.sign_type === 'SIGN_IN') {
        for (const [shopId, old] of opens) {
          if (shopId !== record.shop_id) {
            await this.insertSegment(tx, workerId, old, null, 'MISSING_SIGN_OUT');
            opens.delete(shopId);
          }
        }
        if (previousOpen) await this.insertSegment(tx, workerId, previousOpen, null, 'MISSING_SIGN_OUT');
        opens.set(record.shop_id, record);
      } else if (previousOpen) {
        await this.insertSegment(tx, workerId, previousOpen, record, null);
        opens.delete(record.shop_id);
      } else {
        await this.insertSegment(tx, workerId, null, record, 'MISSING_SIGN_IN');
        for (const [shopId, open] of opens) if (shopId !== record.shop_id) crossShopUnclosed.add(open.id);
      }
    }

    for (const signIn of opens.values()) {
      const old = localDate(signIn.original_occurred_at) < localDate(new Date());
      await this.insertSegment(tx, workerId, signIn, null, old || crossShopUnclosed.has(signIn.id) ? 'MISSING_SIGN_OUT' : null);
    }
  }

  /** Mirrors legacy's shared `GET /attendance` + `GET /manager/staff-attendance` handler. */
  async listRecords(account: Account, staffMode: boolean, range: DateRangeDto, rawQuery: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.checkRangeWithinAMonth(range);

    const shopCodes = asCodeQueryValue(rawQuery.shopIds ?? rawQuery.shopId);
    const workerCodes = asCodeQueryValue(rawQuery.workerIds ?? rawQuery.workerId);
    const scope = staffMode
      ? await this.staffAttendanceScope(this.db, account, shopCodes, workerCodes, rawQuery.includeDeleted === 'true')
      : await this.personalAttendanceScope(this.db, account, shopCodes, workerCodes);

    const rows = await this.queryAttendanceListing(this.db, scope.workerIds, scope.shopIds, range.fromDate, range.toDate);
    const dailyHours = this.attendanceDays(rows);

    return { items: rows, dailyHours, totalHours: totalAttendanceHours(dailyHours) };
  }

  /** Mirrors legacy's `GET /manager/staff-attendance/staff`. */
  async listStaff(account: Account, includeDeleted: boolean): Promise<StaffListingRow[]> {
    await this.ensureWorkerRow(this.db, account.id, '', '');

    const staff = await this.queryStaffListing(this.db, account.role, account.id);

    return includeDeleted ? staff.filter((p) => ['ACTIVE', 'DISABLED'].includes(p.status)) : staff.filter((p) => p.status === 'ACTIVE');
  }

  /** Mirrors legacy's `GET /manager/attendance/locations`. */
  async listLocations(account: Account, range: DateRangeDto, cursor: number, rawQuery: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.scope.isCompanyAdmin(account)) throw apiError(403, 'General manager or Owner required');
    this.checkRangeWithinAMonth(range);

    const scope = await this.staffAttendanceScope(this.db, account, asCodeQueryValue(rawQuery.shopIds), asCodeQueryValue(rawQuery.workerIds));
    const rows = await this.queryLocations(this.db, scope.workerIds, scope.shopIds, range.fromDate, range.toDate);

    const records = rows.map((row) => {
      const gps = attendanceLocation(row.location, row.shop_latitude, row.shop_longitude);
      return {
        id: row.id,
        photoId: row.photo_id,
        workerId: row.worker_id,
        workerName: row.worker_name,
        workerCode: row.worker_code,
        shopName: row.shop_name,
        type: row.sign_type,
        originalTime: row.original_occurred_at,
        currentTime: row.effective_occurred_at,
        confirmedTime: row.manager_confirmed ? row.confirmed_occurred_at : null,
        ...(gps ?? { latitude: null, longitude: null, distanceMeters: null, accuracyMeters: null, capturedAt: null }),
      };
    });

    return {
      items: records.slice(cursor, cursor + 100),
      total: records.length,
      nextCursor: cursor + 100 < records.length ? String(cursor + 100) : null,
    };
  }

  /** Mirrors legacy's `GET /manager/attendance/stores`. */
  async managerStores(account: Account): Promise<StoreListRow[]> {
    return this.queryManagerStores(this.db, account.role, account.id);
  }

  /** Mirrors legacy's `GET /manager/attendance/groomers`. */
  async managerGroomers(account: Account): Promise<GroomerListRow[]> {
    return this.queryManagerGroomers(this.db, account.role, account.id);
  }

  /** Mirrors legacy's `GET /manager/attendance` (the paginated admin table — a separate scope scheme from `staffAttendanceScope`). */
  async managerRecordsPage(account: Account, query: ManagerAttendanceListQueryDto): Promise<Record<string, unknown>> {
    const period = monthBounds(query.month);
    const all = await this.queryManagerRecords(this.db, account.role, account.id, period, query.shopId ?? null, query.workerId ?? null);

    return {
      items: all.slice(query.cursor, query.cursor + query.limit),
      nextCursor: query.cursor + query.limit < all.length ? String(query.cursor + query.limit) : null,
      period,
    };
  }

  /** Mirrors legacy's `GET /manager/attendance/summary`. */
  async managerSummary(account: Account, query: ManagerAttendanceSummaryQueryDto): Promise<Record<string, unknown>> {
    const period = monthBounds(query.month);
    const groups = await this.queryManagerSummary(this.db, account.role, account.id, period, query.shopId ?? null, query.workerId ?? null);

    return { groups, period };
  }

  /** Mirrors legacy's `GET [/manager/attendance/:id/history, /attendance/:id/history]`. */
  async getHistory(account: Account, recordId: string): Promise<Record<string, unknown>> {
    const record = await this.queryFullRecordById(this.db, recordId);
    if (!record) throw apiError(404, 'Record not found');

    if (account.role === 'WORKER') {
      const owner = await this.queryWorkerAccountId(this.db, record.worker_id);
      if (owner?.account_id !== account.id) throw apiError(403, 'Only your own history');
    } else {
      await this.scope.assertRecordScope(this.db, account, record.shop_id, record.worker_id);
    }

    const history = await this.queryAdjustmentHistory(this.db, record.id);

    return { record, history };
  }

  /** Mirrors legacy's `GET /manager/validations`. */
  async listValidations(account: Account, query: ManagerAttendanceSummaryQueryDto): Promise<unknown[]> {
    const period = monthBounds(query.month);
    const shopCode = query.shopId ?? null;
    const workerCode = query.workerId ?? null;

    const adjustments = await this.queryPendingAdjustments(this.db, account.role, account.id, period, shopCode, workerCode);
    const issues = await this.queryInvalidIssues(this.db, account.role, account.id, period, shopCode, workerCode);
    const people = account.role === 'GENERAL_MANAGER' ? await this.queryPendingPeople(this.db) : [];

    return [...people, ...adjustments, ...issues];
  }

  /** Mirrors legacy's `POST /manager/validations/:id/decision`. */
  async decideValidation(account: Account, adjustmentId: string, dto: DecisionDto): Promise<Record<string, unknown>> {
    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'VALIDATION', { ...dto, adjustmentId }, async () => {
        const reference = await this.queryAdjustmentRecordId(tx, adjustmentId);
        if (!reference) throw apiError(404, 'Adjustment missing');

        const record = await this.lockFullRecordById(tx, reference.record_id);
        const adjustment = await this.lockAdjustmentById(tx, adjustmentId);
        if (!record || !adjustment) throw apiError(404, 'Adjustment missing');

        await this.scope.assertRecordScope(tx, account, record.shop_id, record.worker_id);

        if (record.version !== dto.expectedRecordVersion || adjustment.status !== 'PENDING') {
          throw apiError(409, 'Record changed; reload', 'VERSION_CONFLICT');
        }
        if (await this.hasOtherPendingAdjustment(tx, record.id, adjustment.id)) throw apiError(409, 'Multiple adjustments require manual resolution');

        const approved = dto.decision === 'APPROVE';
        const resultingAt = approved ? adjustment.after_at : record.confirmed_occurred_at;
        const deleted = approved ? adjustment.action === 'DELETE' : record.confirmed_deleted;
        const type = approved ? adjustment.after_type || record.sign_type : record.sign_type;

        await this.updateAdjustmentStatus(tx, adjustment.id, approved ? 'APPROVED' : 'REJECTED');
        await this.insertValidation(tx, adjustment.id, account.id, dto.decision, record.confirmed_occurred_at, resultingAt);
        await this.updateRecordForDecision(tx, record.id, resultingAt, deleted, type, approved);
        await this.rebuildWorkSegments(tx, record.worker_id);
        await this.audit.record(tx, account.id, 'VALIDATION_' + dto.decision, record.id);

        return { recordId: record.id, version: record.version + 1 };
      }),
    );
  }

  /** Mirrors legacy's `POST /manager/attendance/:id/corrections` — a manager-only direct edit via the adjustment pipeline. */
  async submitCorrection(account: Account, recordId: string, dto: CorrectionDto): Promise<Record<string, unknown>> {
    return this.submitAdjustment(account, true, {
      operationId: dto.operationId,
      action: 'UPDATE',
      recordId,
      expectedVersion: dto.expectedRecordVersion,
      occurredAt: dto.occurredAt,
      type: dto.type,
    });
  }

  /** Mirrors legacy's `attendanceAdjustment()`, shared by the adjustments endpoints and corrections. */
  async submitAdjustment(account: Account, managerEndpoint: boolean, dto: AdjustmentDto): Promise<Record<string, unknown>> {
    const managerRequest = BACKEND_ROLES.includes(account.role as Role);

    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'ADJUSTMENT', dto, async () => {
        const record: AdjustmentRecordRow =
          dto.action === 'ADD'
            ? await this.createAdjustmentRecord(tx, account, managerEndpoint, dto)
            : await this.loadAdjustmentRecord(tx, account, managerEndpoint, managerRequest, dto);

        const pending = await this.lockPendingAdjustments(tx, record.id);
        if (!managerRequest && pending.length > 1) throw apiError(409, 'Multiple pending changes require manager resolution');

        if (managerRequest) return this.applyManagerAdjustment(tx, account, record, pending, dto);

        return this.queueWorkerAdjustment(tx, account, record, pending, dto);
      }),
    );
  }

  private async createAdjustmentRecord(
    tx: Prisma.TransactionClient,
    account: Account,
    managerEndpoint: boolean,
    dto: AdjustmentDto,
  ): Promise<AdjustmentRecordRow> {
    if (!dto.occurredAt || !dto.type) throw apiError(422, 'Time and type required');

    let workerId: string;
    let shopId: string;

    if (managerEndpoint) {
      const worker = await this.queryAdjustmentWorkerByCode(tx, dto.workerId ?? null, account.id);
      const shop = dto.shopId ? await this.shopByCode(tx, dto.shopId) : undefined;
      if (!worker || !shop) throw apiError(422, 'Active employee and store required');
      await this.scope.assertRecordScope(tx, account, shop.id, worker.id);
      workerId = worker.id;
      shopId = shop.id;
    } else {
      const { worker, shop } = await this.resolveAppScope(tx, account, dto.shopId, dto.workerId || account.login_code);
      workerId = worker.id;
      shopId = shop!.id;
    }

    await this.lockWorkerForRebuild(tx, workerId);

    return this.insertManualAdjustmentRecord(tx, workerId, shopId, account.id, dto.type, dto.occurredAt);
  }

  private async loadAdjustmentRecord(
    tx: Prisma.TransactionClient,
    account: Account,
    managerEndpoint: boolean,
    managerRequest: boolean,
    dto: AdjustmentDto,
  ): Promise<AdjustmentWorkerLoadRow> {
    if (!dto.recordId || !dto.expectedVersion) throw apiError(422, 'Record and version required');

    const record = await this.lockAdjustmentRecordById(tx, dto.recordId);
    if (!record) throw apiError(404, 'Record missing');

    if (managerEndpoint) {
      await this.scope.assertRecordScope(tx, account, record.shop_id, record.worker_id);
    } else {
      const owner = await this.queryWorkerAccountId(tx, record.worker_id);
      if (account.role !== 'SHOP' && owner?.account_id !== account.id) throw apiError(403, 'Only your own records');
      await this.resolveAppScope(tx, account, record.shop_code, record.worker_code);
    }

    if (!managerRequest && record.manager_confirmed) throw apiError(403, 'Confirmed records can only be changed by a manager', 'RECORD_CONFIRMED');
    if (record.confirmed_deleted) throw apiError(409, 'Record is already marked for removal');
    if (record.version !== dto.expectedVersion) throw apiError(409, 'Record changed');
    if (dto.action === 'UPDATE' && !dto.occurredAt) throw apiError(422, 'Time required');

    return record;
  }

  private async applyManagerAdjustment(
    tx: Prisma.TransactionClient,
    account: Account,
    record: AdjustmentRecordRow,
    pending: PendingAdjustmentRow[],
    dto: AdjustmentDto,
  ): Promise<Record<string, unknown>> {
    for (const old of pending) {
      await this.updateAdjustmentStatus(tx, old.id, 'REJECTED');
      await this.insertValidation(tx, old.id, account.id, 'REJECT', record.confirmed_occurred_at, record.confirmed_occurred_at);
      await this.audit.record(tx, account.id, 'ATTENDANCE_REQUEST_SUPERSEDED', record.id, { adjustmentId: old.id }, { reason: 'Direct manager change' });
    }

    const deleting = dto.action === 'DELETE';
    const type = dto.type || record.sign_type;
    const after = deleting ? null : dto.occurredAt ?? null;

    const adjustment = await this.insertManagerAdjustment(tx, record, account.id, dto.action, after, deleting ? null : type);
    await this.insertValidation(tx, adjustment.id, account.id, 'APPROVE', record.confirmed_occurred_at, after);
    await this.updateRecordForManagerEdit(tx, record.id, type, after, deleting);
    await this.rebuildWorkSegments(tx, record.worker_id);
    await this.audit.record(
      tx,
      account.id,
      `ATTENDANCE_MANAGER_${dto.action}`,
      record.id,
      { time: record.effective_occurred_at, type: record.sign_type },
      { time: after, type: deleting ? null : type },
    );

    return {
      recordId: record.id,
      adjustmentId: adjustment.id,
      recordStatus: deleting ? 'removal' : 'active',
      validationStatus: 'APPROVED',
      version: record.version + 1,
    };
  }

  private async queueWorkerAdjustment(
    tx: Prisma.TransactionClient,
    account: Account,
    record: AdjustmentRecordRow,
    pending: PendingAdjustmentRow[],
    dto: AdjustmentDto,
  ): Promise<Record<string, unknown>> {
    const after = dto.action === 'DELETE' ? null : dto.occurredAt ?? null;
    const finalType = dto.type || pending[0]?.after_type || record.sign_type;

    const adjustment = pending.length
      ? await this.updatePendingAdjustment(tx, pending[0]!.id, account.id, dto.action, after, dto.action === 'DELETE' ? null : finalType, record.version)
      : await this.insertWorkerAdjustment(tx, record, account.id, dto.action, after, dto.action === 'DELETE' ? null : finalType);

    await this.updateRecordForPendingEdit(tx, record.id, after, dto.action === 'DELETE');
    await this.rebuildWorkSegments(tx, record.worker_id);
    await this.audit.record(tx, account.id, `ATTENDANCE_${dto.action === 'DELETE' ? 'REMOVAL' : dto.action}_REQUEST`, record.id);

    return {
      recordId: record.id,
      recordStatus: dto.action === 'DELETE' ? 'removal' : 'active',
      adjustmentId: adjustment.id,
      validationStatus: 'PENDING',
    };
  }

  private async queryFullRecordById(c: Queryable, id: string): Promise<AdjustmentRecordRow | undefined> {
    const [record] = await c.$queryRaw<AdjustmentRecordRow[]>`SELECT * FROM attendance_records WHERE id=${id}::uuid`;
    return record;
  }

  private async lockFullRecordById(tx: Prisma.TransactionClient, id: string): Promise<AdjustmentRecordRow | undefined> {
    const [record] = await tx.$queryRaw<AdjustmentRecordRow[]>`SELECT * FROM attendance_records WHERE id=${id}::uuid FOR UPDATE`;
    return record;
  }

  private async queryWorkerAccountId(c: Queryable, workerId: string): Promise<WorkerAccountIdRow | undefined> {
    const [row] = await c.$queryRaw<WorkerAccountIdRow[]>`SELECT account_id FROM workers WHERE id=${workerId}::uuid`;
    return row;
  }

  private async queryAdjustmentHistory(c: Queryable, recordId: string): Promise<AdjustmentHistoryRow[]> {
    return c.$queryRaw<AdjustmentHistoryRow[]>`
      SELECT a.*,v.decision,v.validated_at,u.name AS validator FROM attendance_adjustments a
      LEFT JOIN attendance_validations v ON v.adjustment_id=a.id LEFT JOIN accounts u ON u.id=v.validated_by_account_id
      WHERE a.record_id=${recordId}::uuid ORDER BY a.created_at`;
  }

  private async queryAdjustmentRecordId(c: Queryable, adjustmentId: string): Promise<{ record_id: string } | undefined> {
    const [row] = await c.$queryRaw<{ record_id: string }[]>`SELECT record_id FROM attendance_adjustments WHERE id=${adjustmentId}::uuid`;
    return row;
  }

  private async lockAdjustmentById(
    tx: Prisma.TransactionClient,
    adjustmentId: string,
  ): Promise<{ id: string; status: string; action: string; after_at: Date | null; after_type: string | null } | undefined> {
    const [row] = await tx.$queryRaw<{ id: string; status: string; action: string; after_at: Date | null; after_type: string | null }[]>`
      SELECT * FROM attendance_adjustments WHERE id=${adjustmentId}::uuid FOR UPDATE`;
    return row;
  }

  private async hasOtherPendingAdjustment(tx: Prisma.TransactionClient, recordId: string, excludeAdjustmentId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ exists: true }[]>`
      SELECT 1 AS exists FROM attendance_adjustments WHERE record_id=${recordId}::uuid AND status='PENDING' AND id<>${excludeAdjustmentId}::uuid`;
    return rows.length > 0;
  }

  private async updateAdjustmentStatus(tx: Prisma.TransactionClient, adjustmentId: string, status: string): Promise<void> {
    await tx.$executeRaw`UPDATE attendance_adjustments SET status=${status} WHERE id=${adjustmentId}::uuid`;
  }

  private async insertValidation(
    tx: Prisma.TransactionClient,
    adjustmentId: string,
    validatedByAccountId: string,
    decision: string,
    previousConfirmedAt: Date | string | null,
    resultingConfirmedAt: Date | string | null,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO attendance_validations(adjustment_id,validated_by_account_id,decision,previous_confirmed_at,resulting_confirmed_at)
      VALUES(${adjustmentId}::uuid,${validatedByAccountId}::uuid,${decision},${previousConfirmedAt}::timestamptz,${resultingConfirmedAt}::timestamptz)`;
  }

  private async updateRecordForDecision(
    tx: Prisma.TransactionClient,
    recordId: string,
    resultingAt: Date | null,
    deleted: boolean,
    type: string,
    managerConfirmed: boolean,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE attendance_records SET confirmed_occurred_at=${resultingAt}::timestamptz,
        effective_occurred_at=COALESCE(${resultingAt}::timestamptz,original_occurred_at),confirmed_deleted=${deleted},effective_deleted=${deleted},
        sign_type=${type},manager_confirmed=manager_confirmed OR ${managerConfirmed},version=version+1
      WHERE id=${recordId}::uuid`;
  }

  private async queryAdjustmentWorkerByCode(tx: Prisma.TransactionClient, code: string | null, accountId: string): Promise<AdjustmentWorkerLookupRow | undefined> {
    const [worker] = await tx.$queryRaw<AdjustmentWorkerLookupRow[]>`
      SELECT w.id FROM workers w JOIN accounts a ON a.id=w.account_id
      WHERE (a.login_code=${code} OR (${code}='__self__' AND a.id=${accountId}::uuid) OR ${code}='__worker__'||w.id::text) AND a.status='ACTIVE'`;
    return worker;
  }

  private async insertManualAdjustmentRecord(
    tx: Prisma.TransactionClient,
    workerId: string,
    shopId: string,
    accountId: string,
    type: string,
    occurredAt: string,
  ): Promise<AdjustmentRecordRow> {
    const [record] = await tx.$queryRaw<AdjustmentRecordRow[]>`
      INSERT INTO attendance_records(worker_id,shop_id,submitted_by_account_id,sign_type,source,original_occurred_at,effective_occurred_at,camera_status)
      VALUES(${workerId}::uuid,${shopId}::uuid,${accountId}::uuid,${type},'MANUAL_ADD',${occurredAt}::timestamptz,${occurredAt}::timestamptz,'NOT_APPLICABLE')
      RETURNING *`;
    return record!;
  }

  private async lockAdjustmentRecordById(tx: Prisma.TransactionClient, recordId: string): Promise<AdjustmentWorkerLoadRow | undefined> {
    const [record] = await tx.$queryRaw<AdjustmentWorkerLoadRow[]>`
      SELECT r.*,wa.login_code AS worker_code,sa.login_code AS shop_code FROM attendance_records r
      JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id JOIN accounts sa ON sa.id=s.account_id
      WHERE r.id=${recordId}::uuid FOR UPDATE OF r`;
    return record;
  }

  private async lockPendingAdjustments(tx: Prisma.TransactionClient, recordId: string): Promise<PendingAdjustmentRow[]> {
    return tx.$queryRaw<PendingAdjustmentRow[]>`SELECT * FROM attendance_adjustments WHERE record_id=${recordId}::uuid AND status='PENDING' FOR UPDATE`;
  }

  private async insertManagerAdjustment(
    tx: Prisma.TransactionClient,
    record: AdjustmentRecordRow,
    accountId: string,
    action: string,
    after: string | null,
    type: string | null,
  ): Promise<AdjustmentIdRow> {
    const beforeAt = action === 'ADD' ? null : record.effective_occurred_at;
    const beforeType = action === 'ADD' ? null : record.sign_type;

    const [adjustment] = await tx.$queryRaw<AdjustmentIdRow[]>`
      INSERT INTO attendance_adjustments(record_id,actor_account_id,source,action,before_at,after_at,base_version,status,before_type,after_type)
      VALUES(${record.id}::uuid,${accountId}::uuid,'MANAGER_EDIT',${action},${beforeAt}::timestamptz,${after}::timestamptz,${record.version},'APPROVED',${beforeType},${type})
      RETURNING id`;
    return adjustment!;
  }

  private async updateRecordForManagerEdit(tx: Prisma.TransactionClient, recordId: string, type: string, after: string | null, deleting: boolean): Promise<void> {
    await tx.$executeRaw`
      UPDATE attendance_records SET sign_type=${type},effective_occurred_at=COALESCE(${after}::timestamptz,effective_occurred_at),
        confirmed_occurred_at=COALESCE(${after}::timestamptz,confirmed_occurred_at),effective_deleted=${deleting},confirmed_deleted=${deleting},
        manager_confirmed=true,version=version+1
      WHERE id=${recordId}::uuid`;
  }

  private async insertWorkerAdjustment(
    tx: Prisma.TransactionClient,
    record: AdjustmentRecordRow,
    accountId: string,
    action: string,
    after: string | null,
    type: string | null,
  ): Promise<AdjustmentIdRow> {
    const beforeAt = action === 'ADD' ? null : record.effective_occurred_at;
    const beforeType = action === 'ADD' ? null : record.sign_type;

    const [adjustment] = await tx.$queryRaw<AdjustmentIdRow[]>`
      INSERT INTO attendance_adjustments(record_id,actor_account_id,source,action,before_at,after_at,base_version,before_type,after_type)
      VALUES(${record.id}::uuid,${accountId}::uuid,'WORKER_EDIT',${action},${beforeAt}::timestamptz,${after}::timestamptz,${record.version},${beforeType},${type})
      RETURNING id`;
    return adjustment!;
  }

  private async updatePendingAdjustment(
    tx: Prisma.TransactionClient,
    adjustmentId: string,
    accountId: string,
    action: string,
    after: string | null,
    type: string | null,
    baseVersion: number,
  ): Promise<AdjustmentIdRow> {
    const [adjustment] = await tx.$queryRaw<AdjustmentIdRow[]>`
      UPDATE attendance_adjustments SET actor_account_id=${accountId}::uuid,action=${action},after_at=${after}::timestamptz,after_type=${type},base_version=${baseVersion}
      WHERE id=${adjustmentId}::uuid RETURNING id`;
    return adjustment!;
  }

  private async updateRecordForPendingEdit(tx: Prisma.TransactionClient, recordId: string, after: string | null, deleting: boolean): Promise<void> {
    await tx.$executeRaw`
      UPDATE attendance_records SET effective_occurred_at=COALESCE(${after}::timestamptz,effective_occurred_at),effective_deleted=${deleting},version=version+1
      WHERE id=${recordId}::uuid`;
  }

  private async queryPendingAdjustments(
    c: Queryable,
    role: string,
    accountId: string,
    period: MonthBounds,
    shopCode: string | null,
    workerCode: string | null,
  ): Promise<AdjustmentQueueRow[]> {
    return c.$queryRaw<AdjustmentQueueRow[]>`
      SELECT j.*,r.version,r.original_occurred_at,r.confirmed_occurred_at,wa.name AS worker_name,s.name AS shop_name,'ADJUSTMENT' AS item_type
      FROM attendance_adjustments j JOIN attendance_records r ON r.id=j.record_id
      JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id JOIN accounts sa ON sa.id=s.account_id
      WHERE (${role} IN('SUPER_MANAGER','GENERAL_MANAGER') OR w.account_id=${accountId}::uuid
         OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=${accountId}::uuid)
         OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.worker_id=w.id AND mw.manager_account_id=${accountId}::uuid))
        AND r.effective_occurred_at >= ${period.start}::timestamptz AND r.effective_occurred_at < ${period.end}::timestamptz
        AND (${shopCode}::text IS NULL OR sa.login_code=${shopCode}) AND (${workerCode}::text IS NULL OR wa.login_code=${workerCode})
        AND j.status='PENDING'
      ORDER BY j.created_at`;
  }

  private async queryInvalidIssues(
    c: Queryable,
    role: string,
    accountId: string,
    period: MonthBounds,
    shopCode: string | null,
    workerCode: string | null,
  ): Promise<IssueQueueRow[]> {
    return c.$queryRaw<IssueQueueRow[]>`
      SELECT g.id,g.issue_code,g.sign_in_record_id,g.sign_out_record_id,r.version,w.id AS worker_id,
        COALESCE(wa.login_code,'__worker__'||w.id::text) AS worker_code,sa.login_code AS shop_code,
        (r.effective_occurred_at AT TIME ZONE ${ATTENDANCE_ZONE})::date::text AS local_date,
        r.original_occurred_at,wa.name AS worker_name,s.name AS shop_name,'RECORD_ERROR' AS item_type
      FROM work_segments g JOIN attendance_records r ON r.id=COALESCE(g.sign_in_record_id,g.sign_out_record_id)
      JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id JOIN accounts sa ON sa.id=s.account_id
      WHERE (${role} IN('SUPER_MANAGER','GENERAL_MANAGER') OR w.account_id=${accountId}::uuid
         OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=${accountId}::uuid)
         OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.worker_id=w.id AND mw.manager_account_id=${accountId}::uuid))
        AND r.effective_occurred_at >= ${period.start}::timestamptz AND r.effective_occurred_at < ${period.end}::timestamptz
        AND (${shopCode}::text IS NULL OR sa.login_code=${shopCode}) AND (${workerCode}::text IS NULL OR wa.login_code=${workerCode})
        AND g.status='INVALID'`;
  }

  private async queryPendingPeople(c: Queryable): Promise<PersonApprovalRow[]> {
    return c.$queryRaw<PersonApprovalRow[]>`
      SELECT id AS account_id,name AS worker_name,email,profile_version AS version,role,'PERSON_APPROVAL' AS item_type,'NEW_PERSON' AS source
      FROM accounts WHERE status='PENDING' AND requires_manager_approval AND password_hash IS NOT NULL AND role IN('WORKER','MANAGER')
      ORDER BY created_at`;
  }

  /** Mirrors legacy's `staffAttendanceScope()` — the set of workers/shops a manager's staff view resolves to. */
  async staffAttendanceScope(
    c: Queryable,
    actor: Account,
    shopCodesValue: CodeQueryValue,
    workerCodesValue: CodeQueryValue,
    includeDeleted = true,
  ): Promise<AttendanceScope> {
    await this.ensureWorkerRow(c, actor.id, '', '');

    const codes = this.selectedCodes(workerCodesValue, WORKER_CODE_PATTERN);
    const available = await this.queryAvailableStaff(c, actor.role, actor.id);
    const chosenShops = this.selectedCodes(shopCodesValue, SHOP_CODE_PATTERN);

    if (actor.role === 'MANAGER' && codes.length && chosenShops.length === 1) {
      const permitted = await this.queryManagerShopPermission(c, actor.id, chosenShops[0]!);
      if (permitted) {
        const additional = await this.queryAdditionalWorkersByCode(c, codes);
        for (const row of additional) if (!available.some((r) => r.id === row.id)) available.push(row);
      }
    }

    if (
      codes.some((code) => !available.some((r) => r.login_code === code || code === '__worker__' + r.id || (code === '__self__' && r.account_id === actor.id)))
    ) {
      throw apiError(403, 'Staff outside your managed groomers');
    }

    const staff = codes.length
      ? available.filter((r) => codes.includes(r.login_code ?? '') || codes.includes('__worker__' + r.id) || (codes.includes('__self__') && r.account_id === actor.id))
      : available.filter((r) => includeDeleted || r.status === 'ACTIVE');

    const stores = await this.attendanceStores(c, shopCodesValue);

    return {
      ...stores,
      workerIds: staff.map((r) => r.id),
      staffName: codes.length ? staff.map((r) => r.name).join(', ') : 'All accessible staff',
      staffCode: staff.length === 1 ? staff[0]!.login_code : null,
    };
  }

  /** Mirrors legacy's `personalAttendanceScope()` — a personal-app request scoped to the caller's own records. */
  async personalAttendanceScope(c: Queryable, account: Account, shopCodesValue: CodeQueryValue, workerCodesValue: CodeQueryValue): Promise<AttendanceScope> {
    const codes = this.selectedCodes(workerCodesValue, WORKER_CODE_PATTERN);
    if (codes.length > 1) throw apiError(403, 'Only your own records');

    const shops = this.selectedCodes(shopCodesValue, SHOP_CODE_PATTERN);
    const { worker } = await this.resolveAppScope(c, account, account.role === 'SHOP' ? shops[0] : null, codes[0] || account.login_code, true);
    const stores = await this.attendanceStores(c, shops);

    if (account.role === 'SHOP') for (const id of stores.shopIds ?? []) await this.scope.assertShop(c, account, id);

    return { ...stores, workerIds: [worker.id] };
  }

  /** Mirrors legacy's `attendanceStores()`. */
  async attendanceStores(c: Queryable, value: CodeQueryValue): Promise<{ shopIds: string[] | null; s: { name: string; id: string | null } | null }> {
    const codes = this.selectedCodes(value, SHOP_CODE_PATTERN);
    if (!codes.length) return { shopIds: null, s: null };

    const rows = await this.queryShopsByLoginCodes(c, codes);
    if (rows.length !== codes.length) throw apiError(422, 'Unknown store');

    return { shopIds: rows.map((r) => r.id), s: { name: rows.map((r) => r.name).join(', '), id: rows.length === 1 ? rows[0]!.id : null } };
  }

  private attendanceDays(records: AttendanceListingRow[]): AttendanceDaySummary[] {
    const groups = new Map<string, AttendanceListingRow[]>();
    for (const record of records) {
      const key = `${record.worker_id}:${record.shop_id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(record);
    }

    return [...groups.values()]
      .flatMap((rows) =>
        dailyAttendanceHours(rows).map((day) => ({
          ...day,
          workerId: rows[0]!.worker_id,
          workerCode: rows[0]!.worker_code || '__worker__' + rows[0]!.worker_id,
          workerName: rows[0]!.worker_name,
          shopId: rows[0]!.shop_id,
          shopCode: rows[0]!.shop_code,
          shopName: rows[0]!.shop_name,
        })),
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.workerName.localeCompare(b.workerName) || a.shopName.localeCompare(b.shopName));
  }

  /** Mirrors legacy's `selectedCodes()` — parses a comma-joined or repeated query value into a deduped, pattern-validated code list. */
  private selectedCodes(value: string | string[] | undefined, pattern: RegExp): string[] {
    if (value == null || value === '') return [];

    const list = Array.isArray(value) ? value : value.split(',');
    if (list.length > 200) throw apiError(422, 'Too many codes selected');
    for (const code of list) if (!pattern.test(code)) throw apiError(422, 'Invalid code');

    return [...new Set(list)];
  }

  private checkRangeWithinAMonth(range: DateRangeDto): void {
    if (range.fromDate > range.toDate || new Date(range.toDate).getTime() - new Date(range.fromDate).getTime() > 30 * 86400000) {
      throw apiError(422, 'Date range must be within 31 days');
    }
  }

  private async queryAvailableStaff(c: Queryable, role: string, accountId: string): Promise<AvailableStaffRow[]> {
    return c.$queryRaw<AvailableStaffRow[]>`
      SELECT w.id,a.id AS account_id,a.name,a.login_code,a.status FROM workers w JOIN accounts a ON a.id=w.account_id
      WHERE (${role} IN('GENERAL_MANAGER','SUPER_MANAGER') AND a.role IN('WORKER','MANAGER','GENERAL_MANAGER'))
         OR (a.role='WORKER' AND EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=${accountId}::uuid AND mw.worker_id=w.id))
         OR a.id=${accountId}::uuid
      ORDER BY a.name`;
  }

  private async queryManagerShopPermission(c: Queryable, accountId: string, shopCode: string): Promise<boolean> {
    const rows = await c.$queryRaw<{ exists: true }[]>`
      SELECT 1 AS exists FROM account_shops x JOIN shops s ON s.id=x.shop_id JOIN accounts a ON a.id=s.account_id
      WHERE x.account_id=${accountId}::uuid AND a.login_code=${shopCode}`;
    return rows.length > 0;
  }

  private async queryAdditionalWorkersByCode(c: Queryable, codes: string[]): Promise<AdditionalStaffRow[]> {
    return c.$queryRaw<AdditionalStaffRow[]>`
      SELECT w.id,a.id AS account_id,a.name,a.login_code FROM workers w JOIN accounts a ON a.id=w.account_id
      WHERE a.role='WORKER' AND (a.login_code=ANY(${codes}::text[]) OR '__worker__'||w.id::text=ANY(${codes}::text[]))`;
  }

  private async queryShopsByLoginCodes(c: Queryable, codes: string[]): Promise<StoreRow[]> {
    return c.$queryRaw<StoreRow[]>`SELECT s.id,s.name FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=ANY(${codes}::text[]) ORDER BY s.name`;
  }

  private async queryStaffListing(c: Queryable, role: string, accountId: string): Promise<StaffListingRow[]> {
    return c.$queryRaw<StaffListingRow[]>`
      SELECT w.id,a.name,COALESCE(a.login_code,CASE WHEN a.id=${accountId}::uuid THEN '__self__' ELSE '__worker__'||w.id::text END) AS "workerId",a.status
      FROM workers w JOIN accounts a ON a.id=w.account_id
      WHERE ((${role} IN('GENERAL_MANAGER','SUPER_MANAGER') AND a.role IN('WORKER','MANAGER','GENERAL_MANAGER'))
         OR (a.role='WORKER' AND EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=${accountId}::uuid AND mw.worker_id=w.id)))
         OR a.id=${accountId}::uuid
      ORDER BY a.name`;
  }

  private async queryAttendanceListing(c: Queryable, workerIds: string[], shopIds: string[] | null, fromDate: string, toDate: string): Promise<AttendanceListingRow[]> {
    return c.$queryRaw<AttendanceListingRow[]>`
      SELECT r.*,wa.name AS worker_name,wa.login_code AS worker_code,sh.name AS shop_name,sa.login_code AS shop_code,
        (SELECT x.after_type FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING' LIMIT 1) AS pending_sign_type,
        EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING') AS pending
      FROM attendance_records r JOIN workers wr ON wr.id=r.worker_id JOIN accounts wa ON wa.id=wr.account_id
      JOIN shops sh ON sh.id=r.shop_id JOIN accounts sa ON sa.id=sh.account_id
      WHERE worker_id=ANY(${workerIds}::uuid[]) AND (${shopIds}::uuid[] IS NULL OR r.shop_id=ANY(${shopIds}::uuid[])) AND NOT confirmed_deleted
        AND (NOT effective_deleted OR EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING'))
        AND (effective_occurred_at AT TIME ZONE ${ATTENDANCE_ZONE})::date BETWEEN ${fromDate}::date AND ${toDate}::date
      ORDER BY effective_occurred_at,id`;
  }

  private async queryLocations(c: Queryable, workerIds: string[], shopIds: string[] | null, fromDate: string, toDate: string): Promise<LocationRow[]> {
    return c.$queryRaw<LocationRow[]>`
      SELECT r.id,r.photo_id,r.worker_id,r.shop_id,r.original_occurred_at,r.effective_occurred_at,r.confirmed_occurred_at,r.manager_confirmed,r.sign_type,r.location,
        wa.name AS worker_name,wa.login_code AS worker_code,s.name AS shop_name,s.latitude AS shop_latitude,s.longitude AS shop_longitude
      FROM attendance_records r JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id
      WHERE r.worker_id=ANY(${workerIds}::uuid[]) AND (${shopIds}::uuid[] IS NULL OR r.shop_id=ANY(${shopIds}::uuid[])) AND NOT r.confirmed_deleted
        AND (r.original_occurred_at AT TIME ZONE ${ATTENDANCE_ZONE})::date BETWEEN ${fromDate}::date AND ${toDate}::date
      ORDER BY r.original_occurred_at,r.id`;
  }

  private async queryManagerStores(c: Queryable, role: string, accountId: string): Promise<StoreListRow[]> {
    return c.$queryRaw<StoreListRow[]>`
      SELECT s.id,s.name,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id
      WHERE ${role} IN('SUPER_MANAGER','GENERAL_MANAGER') OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.account_id=${accountId}::uuid AND ac.shop_id=s.id)
         OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=${accountId}::uuid)
      ORDER BY s.name`;
  }

  private async queryManagerGroomers(c: Queryable, role: string, accountId: string): Promise<GroomerListRow[]> {
    return c.$queryRaw<GroomerListRow[]>`
      SELECT w.id,a.id AS "accountId",a.name,a.login_code AS "workerId",a.status FROM workers w JOIN accounts a ON a.id=w.account_id
      WHERE a.role='WORKER' AND a.status='ACTIVE' AND (${role} IN('SUPER_MANAGER','GENERAL_MANAGER')
         OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=${accountId}::uuid AND mw.worker_id=w.id)
         OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.account_id=${accountId}::uuid))
      ORDER BY a.name`;
  }

  private async queryManagerRecords(
    c: Queryable,
    role: string,
    accountId: string,
    period: MonthBounds,
    shopCode: string | null,
    workerCode: string | null,
  ): Promise<ManagerAttendanceRecordRow[]> {
    return c.$queryRaw<ManagerAttendanceRecordRow[]>`
      SELECT r.*,(SELECT x.after_type FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING' LIMIT 1) AS pending_sign_type,
        wa.name AS worker_name,wa.login_code AS "workerId",s.name AS shop_name,sa.login_code AS "shopId",
        EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING') AS pending
      FROM attendance_records r JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id JOIN accounts sa ON sa.id=s.account_id
      WHERE (${role} IN('SUPER_MANAGER','GENERAL_MANAGER') OR w.account_id=${accountId}::uuid
         OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=${accountId}::uuid)
         OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.worker_id=w.id AND mw.manager_account_id=${accountId}::uuid))
        AND r.effective_occurred_at >= ${period.start}::timestamptz AND r.effective_occurred_at < ${period.end}::timestamptz
        AND (${shopCode}::text IS NULL OR sa.login_code=${shopCode}) AND (${workerCode}::text IS NULL OR wa.login_code=${workerCode})
        AND (${role}='SUPER_MANAGER' OR NOT r.effective_deleted)
      ORDER BY r.effective_occurred_at,r.id`;
  }

  private async queryManagerSummary(
    c: Queryable,
    role: string,
    accountId: string,
    period: MonthBounds,
    shopCode: string | null,
    workerCode: string | null,
  ): Promise<ManagerSummaryGroupRow[]> {
    return c.$queryRaw<ManagerSummaryGroupRow[]>`
      SELECT wa.login_code AS "workerId",wa.name AS worker_name,sa.login_code AS "shopId",s.name AS shop_name,
        COALESCE(sum(g.hrs) FILTER(WHERE g.status='CONFIRMED'),0)::numeric(12,2)::text AS "confirmedHrs",
        count(*) FILTER(WHERE g.status='PENDING')::int AS "pendingSegmentCount",
        count(*) FILTER(WHERE g.status='INVALID')::int AS "invalidSegmentCount"
      FROM work_segments g JOIN workers w ON w.id=g.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=g.shop_id JOIN accounts sa ON sa.id=s.account_id
      LEFT JOIN attendance_records rr ON rr.id=COALESCE(g.sign_in_record_id,g.sign_out_record_id)
      WHERE (${role} IN('SUPER_MANAGER','GENERAL_MANAGER') OR w.account_id=${accountId}::uuid
         OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=${accountId}::uuid)
         OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.worker_id=w.id AND mw.manager_account_id=${accountId}::uuid))
        AND COALESCE(g.start_at,rr.effective_occurred_at)>=${period.start}::timestamptz AND COALESCE(g.start_at,rr.effective_occurred_at)<${period.end}::timestamptz
        AND (${shopCode}::text IS NULL OR sa.login_code=${shopCode}) AND (${workerCode}::text IS NULL OR wa.login_code=${workerCode})
      GROUP BY wa.login_code,wa.name,sa.login_code,s.name ORDER BY wa.name`;
  }

  private async checkDailyCountExpectation(
    tx: Prisma.TransactionClient,
    workerId: string,
    shopId: string,
    occurredAt: string,
    expectedDailyCount: number,
  ): Promise<void> {
    const day = localDate(occurredAt);
    const count = await this.dailyAttendanceCount(tx, workerId, shopId, day);
    if (day !== localDate(new Date()) || count !== expectedDailyCount) throw apiError(409, "Attendance changed; refresh today's status", 'ATTENDANCE_CHANGED');
  }

  private async checkPhoto(tx: Prisma.TransactionClient, account: Account, dto: ClockDto): Promise<void> {
    if (dto.cameraStatus === 'AVAILABLE') {
      if (!dto.photoId) throw apiError(422, 'Photo required');
      const ready = await this.queryReadyPhoto(tx, dto.photoId, account.id);
      if (!ready) throw apiError(422, 'Photo unavailable');
    } else if (dto.photoId) {
      throw apiError(422, 'Unavailable camera cannot include photo');
    }
  }

  private resolvePosition(account: Account, dto: ClockDto, shop: ClockShopRow): LocationPosition {
    if (account.role === 'SHOP') return { status: 'NOT_APPLICABLE' };
    if (dto.location?.status !== 'AVAILABLE') return { status: 'UNAVAILABLE' };

    const lat = dto.location.latitude!;
    const lon = dto.location.longitude!;
    const shopLatitude = Number(shop.latitude);
    const shopLongitude = Number(shop.longitude);
    const rad = (n: number): number => (n * Math.PI) / 180;
    const h = Math.sin(rad(lat - shopLatitude) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(shopLatitude)) * Math.sin(rad(lon - shopLongitude) / 2) ** 2;
    const distance = 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));

    return {
      ...dto.location,
      status: distance <= 500 ? 'IN_RANGE' : 'OUT_OF_RANGE',
      distanceMeters: distance,
      shopLatitude,
      shopLongitude,
    };
  }

  private async ensureWorkerRow(c: Queryable, accountId: string, contact: string | null, address: string | null): Promise<void> {
    await c.$executeRaw`INSERT INTO workers(account_id,contact,address) VALUES(${accountId}::uuid,${contact},${address}) ON CONFLICT(account_id) DO NOTHING`;
  }

  private async queryAppScopeWorker(c: Queryable, workerCode: string | null, accountId: string): Promise<AppScopeWorkerRow | undefined> {
    const [worker] = await c.$queryRaw<AppScopeWorkerRow[]>`
      SELECT w.id,w.account_id,a.status AS account_status FROM workers w JOIN accounts a ON a.id=w.account_id
      WHERE (${workerCode}::text IS NOT NULL AND a.login_code=${workerCode})
         OR (${workerCode}::text IS NULL AND a.id=${accountId}::uuid AND a.role IN('WORKER','MANAGER','GENERAL_MANAGER','SUPER_MANAGER'))`;
    return worker;
  }

  private async queryAppScopeShop(c: Queryable, shopCode: string): Promise<AppScopeShopRow | undefined> {
    const [shop] = await c.$queryRaw<AppScopeShopRow[]>`SELECT s.id,s.name,s.latitude,s.longitude FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=${shopCode}`;
    return shop;
  }

  private async lockActiveWorkerByCode(tx: Prisma.TransactionClient, workerCode: string): Promise<ClockWorkerRow | undefined> {
    const [worker] = await tx.$queryRaw<ClockWorkerRow[]>`
      SELECT w.id,a.id AS account_id FROM workers w JOIN accounts a ON a.id=w.account_id
      WHERE a.login_code=${workerCode} AND a.status='ACTIVE' FOR UPDATE OF w`;
    return worker;
  }

  private async shopByCode(tx: Prisma.TransactionClient, shopCode: string): Promise<ClockShopRow | undefined> {
    const [shop] = await tx.$queryRaw<ClockShopRow[]>`SELECT s.id,s.name,s.latitude,s.longitude FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=${shopCode}`;
    return shop;
  }

  private async queryReadyPhoto(tx: Prisma.TransactionClient, photoId: string, accountId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ exists: true }[]>`SELECT 1 AS exists FROM photos WHERE id=${photoId}::uuid AND uploaded_by_account_id=${accountId}::uuid AND status='READY'`;
    return rows.length > 0;
  }

  private async hasSignInToday(c: Queryable, workerId: string, day: string): Promise<boolean> {
    const rows = await c.$queryRaw<{ exists: true }[]>`
      SELECT 1 AS exists FROM attendance_records WHERE worker_id=${workerId}::uuid AND sign_type='SIGN_IN' AND (original_occurred_at AT TIME ZONE ${ATTENDANCE_ZONE})::date=${day}::date`;
    return rows.length > 0;
  }

  private async insertAttendanceRecord(
    tx: Prisma.TransactionClient,
    workerId: string,
    shopId: string,
    account: Account,
    dto: ClockDto,
    first: boolean,
    position: LocationPosition,
  ): Promise<AttendanceRecordRow> {
    const source = account.role === 'SHOP' ? 'SHOP_DEVICE' : 'PERSONAL_APP';
    const plannedStartAt = first ? dto.plannedStartAt ?? null : null;

    const [record] = await tx.$queryRaw<AttendanceRecordRow[]>`
      INSERT INTO attendance_records(worker_id,shop_id,submitted_by_account_id,sign_type,source,original_occurred_at,planned_start_at,effective_occurred_at,confirmed_occurred_at,offline,camera_status,photo_id,location)
      VALUES(${workerId}::uuid,${shopId}::uuid,${account.id}::uuid,${dto.type},${source},${dto.occurredAt}::timestamptz,${plannedStartAt}::timestamptz,${dto.occurredAt}::timestamptz,${dto.occurredAt}::timestamptz,${dto.offline},${dto.cameraStatus},${dto.photoId ?? null},${JSON.stringify(position)}::jsonb)
      RETURNING id,original_occurred_at,sign_type`;
    return record!;
  }

  private async queryDailyAttendanceCount(c: Queryable, workerId: string, shopId: string, day: string): Promise<{ count: number }[]> {
    return c.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM attendance_records WHERE worker_id=${workerId}::uuid AND shop_id=${shopId}::uuid AND NOT effective_deleted AND (effective_occurred_at AT TIME ZONE ${ATTENDANCE_ZONE})::date=${day}::date`;
  }

  private async latestRecordToday(c: Queryable, workerId: string, shopId: string, day: string): Promise<{ id: string } | undefined> {
    const [record] = await c.$queryRaw<{ id: string }[]>`
      SELECT id FROM attendance_records WHERE worker_id=${workerId}::uuid AND shop_id=${shopId}::uuid AND NOT effective_deleted AND (effective_occurred_at AT TIME ZONE ${ATTENDANCE_ZONE})::date=${day}::date
      ORDER BY effective_occurred_at DESC,id DESC LIMIT 1`;
    return record;
  }

  private async lockWorkerForRebuild(tx: Prisma.TransactionClient, workerId: string): Promise<void> {
    await tx.$executeRaw`SELECT id FROM workers WHERE id=${workerId}::uuid FOR UPDATE`;
  }

  private async deleteWorkSegments(tx: Prisma.TransactionClient, workerId: string): Promise<void> {
    await tx.$executeRaw`DELETE FROM work_segments WHERE worker_id=${workerId}::uuid`;
  }

  private async queryRecordsForRebuild(tx: Prisma.TransactionClient, workerId: string): Promise<RebuildRecordRow[]> {
    return tx.$queryRaw<RebuildRecordRow[]>`
      SELECT r.id,r.shop_id,r.sign_type,r.original_occurred_at,r.confirmed_occurred_at,
        EXISTS(SELECT 1 FROM attendance_adjustments j WHERE j.record_id=r.id AND j.status='PENDING') AS pending
      FROM attendance_records r WHERE worker_id=${workerId}::uuid AND NOT confirmed_deleted
      ORDER BY COALESCE(confirmed_occurred_at,original_occurred_at),received_at,id`;
  }

  private async insertSegment(
    tx: Prisma.TransactionClient,
    workerId: string,
    signIn: RebuildRecordRow | null,
    signOut: RebuildRecordRow | null,
    initialIssue: string | null,
  ): Promise<void> {
    const start = signIn?.confirmed_occurred_at ?? null;
    const end = signOut?.confirmed_occurred_at ?? null;

    let issue = initialIssue;
    let status = issue ? 'INVALID' : signIn?.pending || signOut?.pending || !start || !end ? 'PENDING' : 'CONFIRMED';

    if (start && end && localDate(start) !== localDate(end)) {
      issue = 'CROSS_MIDNIGHT';
      status = 'INVALID';
    }
    if (start && end && end < start) {
      issue = 'REVERSED_TIME';
      status = 'INVALID';
    }

    const shopId = signIn?.shop_id ?? signOut!.shop_id;
    await this.insertWorkSegmentRow(tx, workerId, shopId, signIn?.id ?? null, signOut?.id ?? null, start, end, status, issue);
  }

  private async insertWorkSegmentRow(
    tx: Prisma.TransactionClient,
    workerId: string,
    shopId: string,
    signInRecordId: string | null,
    signOutRecordId: string | null,
    start: Date | null,
    end: Date | null,
    status: string,
    issue: string | null,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO work_segments(worker_id,shop_id,sign_in_record_id,sign_out_record_id,start_at,end_at,status,issue_code,duration_minutes,hrs)
      VALUES(${workerId}::uuid,${shopId}::uuid,${signInRecordId}::uuid,${signOutRecordId}::uuid,${start}::timestamptz,${end}::timestamptz,${status},${issue},
        CASE WHEN ${status}='CONFIRMED' THEN extract(epoch FROM (${end}::timestamptz-${start}::timestamptz))/60 END,
        CASE WHEN ${status}='CONFIRMED' THEN round((extract(epoch FROM (${end}::timestamptz-${start}::timestamptz))/3600)::numeric,2) END)`;
  }
}
