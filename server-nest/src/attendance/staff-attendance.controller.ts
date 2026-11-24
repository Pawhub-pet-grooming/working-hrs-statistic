import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { BACKEND_ROLES, type Account } from '../auth/types.js';
import {
  dateRangeQuerySchema,
  exportSchema,
  staffListingQuerySchema,
  type DateRangeDto,
  type ExportDto,
  type StaffListingQueryDto,
} from './attendance.schemas.js';
import { AttendanceService } from './attendance.service.js';

/** Mirrors legacy's blanket `/api/v1/manager` role gate — every route here requires a backend role. */
@Controller('api/v1/manager/staff-attendance')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class StaffAttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  async list(
    @CurrentAccount() account: Account,
    @Query({ schema: dateRangeQuerySchema }) range: DateRangeDto,
    @Query() raw: Record<string, unknown>,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.listRecords(account, true, range, raw) };
  }

  @Get('staff')
  async listStaff(
    @CurrentAccount() account: Account,
    @Query({ schema: staffListingQuerySchema }) query: StaffListingQueryDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.listStaff(account, query.includeDeleted === 'true') };
  }

  @Post('exports')
  @HttpCode(202)
  async exportRecords(
    @CurrentAccount() account: Account,
    @Body({ schema: exportSchema }) dto: ExportDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.exportRecords(account, true, dto) };
  }
}
