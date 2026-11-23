import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AttendanceAdjustmentsController } from './attendance-adjustments.controller.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { ManagerAttendanceAdjustmentsController } from './manager-attendance-adjustments.controller.js';
import { ManagerAttendanceController } from './manager-attendance.controller.js';
import { StaffAttendanceController } from './staff-attendance.controller.js';
import { ValidationsController } from './validations.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [
    AttendanceController,
    StaffAttendanceController,
    ManagerAttendanceController,
    AttendanceAdjustmentsController,
    ManagerAttendanceAdjustmentsController,
    ValidationsController,
  ],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
