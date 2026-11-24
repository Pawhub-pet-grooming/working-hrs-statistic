import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { Account } from '../auth/types.js';
import {
  clockSchema,
  dateRangeQuerySchema,
  exportSchema,
  recordIdParamSchema,
  statusQuerySchema,
  type ClockDto,
  type DateRangeDto,
  type ExportDto,
  type StatusQueryDto,
} from './attendance.schemas.js';
import { AttendanceService } from './attendance.service.js';

/** Mirrors legacy's personal `/api/v1/attendance*` routes (server/src/app.js). */
@Controller('api/v1/attendance')
@UseGuards(SessionAuthGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post()
  async clockInOrOut(
    @CurrentAccount() account: Account,
    @Body({ schema: clockSchema }) dto: ClockDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.clockInOrOut(account, dto) };
  }

  @Get('status')
  async status(
    @CurrentAccount() account: Account,
    @Query({ schema: statusQuerySchema }) query: StatusQueryDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.status(account, query.shopId, query.workerId) };
  }

  @Get(':id/history')
  async history(
    @CurrentAccount() account: Account,
    @Param('id', { schema: recordIdParamSchema }) id: string,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.getHistory(account, id) };
  }

  @Get('summary')
  async summary(
    @CurrentAccount() account: Account,
    @Query({ schema: statusQuerySchema }) query: StatusQueryDto,
    @Query({ schema: dateRangeQuerySchema }) range: DateRangeDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.personalSummary(account, query.shopId, query.workerId, range) };
  }

  @Post('exports')
  @HttpCode(202)
  async exportRecords(
    @CurrentAccount() account: Account,
    @Body({ schema: exportSchema }) dto: ExportDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.exportRecords(account, false, dto) };
  }

  @Get()
  async list(
    @CurrentAccount() account: Account,
    @Query({ schema: dateRangeQuerySchema }) range: DateRangeDto,
    @Query() raw: Record<string, unknown>,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.listRecords(account, false, range, raw) };
  }
}
