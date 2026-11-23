import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { BACKEND_ROLES, type Account } from '../auth/types.js';
import {
  correctionSchema,
  dateRangeQuerySchema,
  locationsCursorQuerySchema,
  managerAttendanceListQuerySchema,
  managerAttendanceSummaryQuerySchema,
  recordIdParamSchema,
  type CorrectionDto,
  type DateRangeDto,
  type LocationsCursorQueryDto,
  type ManagerAttendanceListQueryDto,
  type ManagerAttendanceSummaryQueryDto,
} from './attendance.schemas.js';
import { AttendanceService } from './attendance.service.js';

/** Mirrors legacy's blanket `/api/v1/manager` role gate — every route here requires a backend role. */
@Controller('api/v1/manager/attendance')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class ManagerAttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('stores')
  async stores(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.attendance.managerStores(account) };
  }

  @Get('groomers')
  async groomers(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.attendance.managerGroomers(account) };
  }

  @Get('summary')
  async summary(
    @CurrentAccount() account: Account,
    @Query({ schema: managerAttendanceSummaryQuerySchema }) query: ManagerAttendanceSummaryQueryDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.managerSummary(account, query) };
  }

  @Get(':id/history')
  async history(@CurrentAccount() account: Account, @Param('id', { schema: recordIdParamSchema }) id: string): Promise<{ data: unknown }> {
    return { data: await this.attendance.getHistory(account, id) };
  }

  @Post(':id/corrections')
  @HttpCode(200)
  async correct(
    @CurrentAccount() account: Account,
    @Param('id', { schema: recordIdParamSchema }) id: string,
    @Body({ schema: correctionSchema }) dto: CorrectionDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.submitCorrection(account, id, dto) };
  }

  @Get('locations')
  async listLocations(
    @CurrentAccount() account: Account,
    @Query({ schema: dateRangeQuerySchema }) range: DateRangeDto,
    @Query({ schema: locationsCursorQuerySchema }) cursorQuery: LocationsCursorQueryDto,
    @Query() raw: Record<string, unknown>,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.listLocations(account, range, cursorQuery.cursor, raw) };
  }

  @Get()
  async list(
    @CurrentAccount() account: Account,
    @Query({ schema: managerAttendanceListQuerySchema }) query: ManagerAttendanceListQueryDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.managerRecordsPage(account, query) };
  }
}
