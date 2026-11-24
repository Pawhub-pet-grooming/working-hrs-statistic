import { Module } from '@nestjs/common';
import { AttendanceExportModule } from '../attendance-export/attendance-export.module.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { MailModule } from '../mail/mail.module.js';
import { PhotosModule } from '../photos/photos.module.js';
import { MaintenanceScheduler } from './maintenance.scheduler.js';

/**
 * Mirrors legacy's `server/src/index.js` maintenance loop via `@nestjs/schedule`. Not yet wired
 * to a live process: `deploy/pawhub.service` still runs bare `server/src/index.js` in production,
 * so legacy's own `setInterval`s remain the real schedulers until Epic 6 cuts the deployed
 * process over to `server-nest`. Building and verifying this now (same precedent as
 * `MailService`/`AttendanceExportService`/`PhotoRetentionService`, all already staged for it).
 */
@Module({
  imports: [AttendanceModule, AttendanceExportModule, MailModule, PhotosModule],
  providers: [MaintenanceScheduler],
})
export class MaintenanceModule {}
