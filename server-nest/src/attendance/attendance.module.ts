import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { ManagerAttendanceController } from './manager-attendance.controller.js';
import { StaffAttendanceController } from './staff-attendance.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [AttendanceController, StaffAttendanceController, ManagerAttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
