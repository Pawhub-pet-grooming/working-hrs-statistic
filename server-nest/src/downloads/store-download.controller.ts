import { Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { BACKEND_ROLES } from '../auth/types.js';
import { StoreDownloadService } from './store-download.service.js';

/** Mirrors legacy's `store-download.js` role check — identical to the blanket `/api/v1/manager` gate. */
@Controller('api/v1/manager/downloads/store-android')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class StoreDownloadController {
  constructor(private readonly downloads: StoreDownloadService) {}

  @Get()
  async metadata(@Res() res: Response): Promise<void> {
    res.set('Cache-Control', 'no-store');
    res.json({ data: await this.downloads.metadata() });
  }

  @Post('link')
  @HttpCode(200)
  async link(@Res() res: Response): Promise<void> {
    res.set('Cache-Control', 'no-store');
    res.json({ data: { url: await this.downloads.signedDownloadUrl() } });
  }
}
