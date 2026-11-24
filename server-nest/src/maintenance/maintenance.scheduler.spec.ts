import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AttendanceExportService } from '../attendance-export/attendance-export.service.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { DbService } from '../database/db.service.js';
import { MailService } from '../mail/mail.service.js';
import { PhotoRetentionService } from '../photos/photo-retention.service.js';
import { MAINTENANCE_TICK_NAME, MaintenanceScheduler, PHOTO_RETENTION_TICK_NAME } from './maintenance.scheduler.js';

describe('MaintenanceScheduler', () => {
  let scheduler: MaintenanceScheduler;
  const findMany = vi.fn();
  const transaction = vi.fn();
  const rebuildWorkSegments = vi.fn();
  const processMailJob = vi.fn();
  const processExportJob = vi.fn();
  const processPhotoRetention = vi.fn();
  const addInterval = vi.fn();

  beforeEach(async () => {
    findMany.mockReset();
    transaction.mockReset().mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
    rebuildWorkSegments.mockReset();
    processMailJob.mockReset().mockResolvedValue(undefined);
    processExportJob.mockReset().mockResolvedValue(undefined);
    processPhotoRetention.mockReset().mockResolvedValue({ deleted: 0, failed: 0, skipped: 0, scanned: 0 });
    addInterval.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MaintenanceScheduler,
        { provide: DbService, useValue: { workers: { findMany }, $transaction: transaction } },
        { provide: AttendanceService, useValue: { rebuildWorkSegments } },
        { provide: MailService, useValue: { processNextJob: processMailJob } },
        { provide: AttendanceExportService, useValue: { processNextJob: processExportJob } },
        { provide: PhotoRetentionService, useValue: { processPhotoRetention } },
        { provide: SchedulerRegistry, useValue: { addInterval } },
      ],
    }).compile();
    scheduler = module.get(MaintenanceScheduler);
  });

  describe('onApplicationBootstrap', () => {
    it('unrefs both ticks so a background timer can never keep the process alive, mirroring legacy', () => {
      vi.useFakeTimers();

      scheduler.onApplicationBootstrap();

      expect(addInterval).toHaveBeenCalledWith(MAINTENANCE_TICK_NAME, expect.anything());
      expect(addInterval).toHaveBeenCalledWith(PHOTO_RETENTION_TICK_NAME, expect.anything());
      for (const [, ref] of addInterval.mock.calls) expect((ref as NodeJS.Timeout).hasRef()).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('runMaintenance', () => {
    it('rebuilds every worker sequentially, then drains one mail job and one export job', async () => {
      findMany.mockResolvedValue([{ id: 'worker-1' }, { id: 'worker-2' }]);

      await scheduler.runMaintenance();

      expect(transaction).toHaveBeenCalledTimes(2);
      expect(rebuildWorkSegments).toHaveBeenNthCalledWith(1, {}, 'worker-1');
      expect(rebuildWorkSegments).toHaveBeenNthCalledWith(2, {}, 'worker-2');
      expect(processMailJob).toHaveBeenCalledTimes(1);
      expect(processExportJob).toHaveBeenCalledTimes(1);
    });

    it('swallows a failure so a bad tick does not crash the process, mirroring legacy', async () => {
      findMany.mockRejectedValue(new Error('boom'));

      await expect(scheduler.runMaintenance()).resolves.toBeUndefined();
      expect(processMailJob).not.toHaveBeenCalled();
    });
  });

  describe('runPhotoRetention', () => {
    it('runs the retention sweep', async () => {
      await scheduler.runPhotoRetention();

      expect(processPhotoRetention).toHaveBeenCalledTimes(1);
    });

    it('is re-entrancy guarded, mirroring legacy\'s retentionRunning flag', async () => {
      let resolveFirst!: () => void;
      processPhotoRetention.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = () => resolve({ deleted: 0, failed: 0, skipped: 0, scanned: 0 });
        }),
      );

      const first = scheduler.runPhotoRetention();
      const second = scheduler.runPhotoRetention();
      resolveFirst();
      await Promise.all([first, second]);

      expect(processPhotoRetention).toHaveBeenCalledTimes(1);
    });

    it('releases the guard after a failure so the next tick can still run', async () => {
      processPhotoRetention.mockRejectedValueOnce(new Error('boom'));
      await scheduler.runPhotoRetention();

      processPhotoRetention.mockResolvedValueOnce({ deleted: 0, failed: 0, skipped: 0, scanned: 0 });
      await scheduler.runPhotoRetention();

      expect(processPhotoRetention).toHaveBeenCalledTimes(2);
    });
  });
});
