import { Body, Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { BACKEND_ROLES, type Account } from '../auth/types.js';
import { reportPdfSchema, type ReportPdfDto } from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

/** Mirrors legacy's blanket `/api/v1/manager` role gate. */
@Controller('api/v1/manager/reports')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * `@HttpCode(200)` is still required even with `@Res()`: Nest's RouterExecutionContext calls
   * `responseController.setStatus(res, httpStatusCode)` unconditionally before invoking the
   * handler — using `@Res()` only skips Nest's own body-serialization step, not this pre-set.
   * Without it this POST defaults to 201 and `res.send()` never overrides an already-set status.
   */
  @Post('pdf')
  @HttpCode(200)
  async pdf(
    @CurrentAccount() account: Account,
    @Body({ schema: reportPdfSchema }) dto: ReportPdfDto,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.reports.buildPdf(account, dto);
    res.type('pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Pawhub-${dto.month}.pdf"`);
    res.send(buffer);
  }
}
