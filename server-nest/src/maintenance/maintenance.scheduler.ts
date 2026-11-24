import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AttendanceExportService } from '../attendance-export/attendance-export.service.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { DbService } from '../database/db.service.js';
import { MailService } from '../mail/mail.service.js';
import { PhotoRetentionService } from '../photos/photo-retention.service.js';

const MAINTENANCE_INTERVAL_MS = 60_000;
const PHOTO_RETENTION_INTERVAL_MS = 15 * 60_000;
export const MAINTENANCE_TICK_NAME = 'maintenance-tick';
export const PHOTO_RETENTION_TICK_NAME = 'photo-retention-tick';

/**
 * Mirrors legacy's `server/src/index.js` maintenance loop. Registers its own timers into
 * `SchedulerRegistry` (rather than `@Interval`) and `unref()`s them immediately, like legacy's
 * `maintenance.unref()`/`photoRetention.unref()` — a background tick must never be the reason the
 * process can't exit. Registering them still lets `@nestjs/schedule`'s own `beforeApplicationShutdown`
 * hook clear them deterministically once a graceful shutdown is wired up (see `onApplicationShutdown`/
 * `enableShutdownHooks` on the app itself).
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceScheduler.name);
  private photoRetentionRunning = false;

  constructor(
    private readonly db: DbService,
    private readonly attendance: AttendanceService,
    private readonly mail: MailService,
    private readonly attendanceExport: AttendanceExportService,
    private readonly photoRetention: PhotoRetentionService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const maintenanceTick = setInterval(() => void this.runMaintenance(), MAINTENANCE_INTERVAL_MS);
    maintenanceTick.unref();
    this.schedulerRegistry.addInterval(MAINTENANCE_TICK_NAME, maintenanceTick);

    const photoRetentionTick = setInterval(() => void this.runPhotoRetention(), PHOTO_RETENTION_INTERVAL_MS);
    photoRetentionTick.unref();
    this.schedulerRegistry.addInterval(PHOTO_RETENTION_TICK_NAME, photoRetentionTick);
  }

  /**
   * Mirrors legacy's SIGTERM handler clearing `maintenance`/`photoRetention` before closing the
   * server and the DB pool. By the time this fires, `@nestjs/schedule`'s own
   * `beforeApplicationShutdown` hook has already cleared both registered ticks (it runs earlier
   * in `app.close()`'s lifecycle than `onApplicationShutdown`) — this just reports it, the
   * equivalent of legacy having nothing left to log once its own clearInterval calls return.
   */
  onApplicationShutdown(signal?: string): void {
    this.logger.log(`Maintenance scheduler stopped${signal ? ` (${signal})` : ''}`);
  }

  /** Mirrors legacy's 60s tick: per-worker `work_segments` rebuild, then one mail job, then one export job. */
  async runMaintenance(): Promise<void> {
    try {
      const workerIds = await this.queryAllWorkerIds();
      for (const workerId of workerIds) await this.rebuildWorker(workerId);

      await this.mail.processNextJob();
      await this.attendanceExport.processNextJob();
    } catch (error) {
      const err = error as { code?: string; name?: string };
      this.logger.error(`Maintenance failure ${err.code || err.name}`);
    }
  }

  /** Mirrors legacy's 15-minute `cleanPhotos()` tick, including its re-entrancy guard. */
  async runPhotoRetention(): Promise<void> {
    if (this.photoRetentionRunning) return;
    this.photoRetentionRunning = true;

    try {
      const result = await this.photoRetention.processPhotoRetention();
      if (result.deleted) this.logger.log(`Expired photos removed: ${result.deleted}`);
    } catch (error) {
      const err = error as { code?: string; name?: string };
      this.logger.error(`Photo retention failure ${err.code || err.name}`);
    } finally {
      this.photoRetentionRunning = false;
    }
  }

  private async rebuildWorker(workerId: string): Promise<void> {
    await this.db.$transaction((tx) => this.attendance.rebuildWorkSegments(tx, workerId));
  }

  private async queryAllWorkerIds(): Promise<string[]> {
    const workers = await this.db.workers.findMany({ select: { id: true } });

    return workers.map((worker) => worker.id);
  }
}
