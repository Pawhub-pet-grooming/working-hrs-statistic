import { Injectable } from '@nestjs/common';
import { BACKEND_ROLES, PERSONAL_ROLES, type Account, type Role } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import { DbService, type Queryable } from '../database/db.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { ScopeService } from '../organization/scope.service.js';
import { ATTENDANCE_ZONE, localDate } from './attendance-domain.util.js';
import type { ClockDto } from './attendance.schemas.js';

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
