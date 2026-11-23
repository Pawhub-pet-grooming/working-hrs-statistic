import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { BACKEND_ROLES, type Account } from '../auth/types.js';
import { adjustmentSchema, type AdjustmentDto } from './attendance.schemas.js';
import { AttendanceService } from './attendance.service.js';

/** Mirrors legacy's manager `POST /api/v1/manager/attendance-adjustments`. */
@Controller('api/v1/manager/attendance-adjustments')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class ManagerAttendanceAdjustmentsController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post()
  async submit(@CurrentAccount() account: Account, @Body({ schema: adjustmentSchema }) dto: AdjustmentDto): Promise<{ data: unknown }> {
    return { data: await this.attendance.submitAdjustment(account, true, dto) };
  }
}
