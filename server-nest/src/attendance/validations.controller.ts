import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { BACKEND_ROLES, type Account } from '../auth/types.js';
import {
  decisionSchema,
  managerAttendanceSummaryQuerySchema,
  recordIdParamSchema,
  type DecisionDto,
  type ManagerAttendanceSummaryQueryDto,
} from './attendance.schemas.js';
import { AttendanceService } from './attendance.service.js';

/** Mirrors legacy's `GET /manager/validations` + `POST /manager/validations/:id/decision`. */
@Controller('api/v1/manager/validations')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class ValidationsController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  async list(
    @CurrentAccount() account: Account,
    @Query({ schema: managerAttendanceSummaryQuerySchema }) query: ManagerAttendanceSummaryQueryDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.listValidations(account, query) };
  }

  @Post(':id/decision')
  async decide(
    @CurrentAccount() account: Account,
    @Param('id', { schema: recordIdParamSchema }) id: string,
    @Body({ schema: decisionSchema }) dto: DecisionDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.attendance.decideValidation(account, id, dto) };
  }
}
