import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { BACKEND_ROLES, type Account } from '../auth/types.js';
import { dateRangeQuerySchema, locationsCursorQuerySchema, type DateRangeDto, type LocationsCursorQueryDto } from './attendance.schemas.js';
import { AttendanceService } from './attendance.service.js';

/** Mirrors legacy's blanket `/api/v1/manager` role gate — every route here requires a backend role. */
@Controller('api/v1/manager/attendance')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class ManagerAttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('locations')
  async listLocations(
    @CurrentAccount() account: Account,
    @Query({ schema: dateRangeQuerySchema }) range: DateRangeDto,
    @Query({ schema: locationsCursorQuerySchema }) cursorQuery: LocationsCursorQueryDto,
    @Query() raw: Record<string, unknown>,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.listLocations(account, range, cursorQuery.cursor, raw) };
  }
}
