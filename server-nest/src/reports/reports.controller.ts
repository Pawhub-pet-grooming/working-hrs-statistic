import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
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

  /** `@Res()` bypasses Nest's own response pipeline, so the handler owns the status (Express defaults to 200, matching legacy). */
  @Post('pdf')
  async pdf(@CurrentAccount() account: Account, @Body({ schema: reportPdfSchema }) dto: ReportPdfDto, @Res() res: Response): Promise<void> {
    const buffer = await this.reports.buildPdf(account, dto);
    res.type('pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Pawhub-${dto.month}.pdf"`);
    res.send(buffer);
  }
}
