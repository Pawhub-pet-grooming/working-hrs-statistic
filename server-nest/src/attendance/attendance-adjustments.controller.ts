import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { Account } from '../auth/types.js';
import { adjustmentSchema, type AdjustmentDto } from './attendance.schemas.js';
import { AttendanceService } from './attendance.service.js';

/** Mirrors legacy's personal `POST /api/v1/attendance-adjustments`. */
@Controller('api/v1/attendance-adjustments')
@UseGuards(SessionAuthGuard)
export class AttendanceAdjustmentsController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post()
  async submit(@CurrentAccount() account: Account, @Body({ schema: adjustmentSchema }) dto: AdjustmentDto): Promise<{ data: unknown }> {
    return { data: await this.attendance.submitAdjustment(account, false, dto) };
  }
}
