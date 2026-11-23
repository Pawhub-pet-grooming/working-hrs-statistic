import { Module } from '@nestjs/common';
import { AttendanceExportService } from './attendance-export.service.js';

/**
 * Built ahead of its live caller: the queue drain isn't wired to anything yet — the legacy
 * `setInterval` in `server/src/index.js` still owns `processAttendanceExports()` in production
 * until Epic 4 introduces `@nestjs/schedule` and switches the maintenance loop over.
 */
@Module({
  providers: [AttendanceExportService],
  exports: [AttendanceExportService],
})
export class AttendanceExportModule {}
