import { Controller, Get, Next, Query, Res } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { AndroidDownloadService } from './android-download.service.js';

/**
 * Mirrors legacy's fully-public `/api/v1/downloads/android*` routes (server/src/app.js) — no
 * guards here. Allow-listed in `publicAuthPaths` (server/src/app.js) so the still-live `/api/v1`
 * session-auth middleware doesn't 401 anonymous requests before they reach this controller.
 */
@Controller('api/v1/downloads/android')
export class AndroidDownloadController {
  constructor(private readonly downloads: AndroidDownloadService) {}

  @Get()
  async metadata(@Res() res: Response): Promise<void> {
    res.set('Cache-Control', 'no-store');
    try {
      res.json({ data: { available: true, ...(await this.downloads.current()) } });
    } catch {
      res.json({ data: { available: false } });
    }
  }

  @Get('apk')
  async download(
    @Query('sha256') sha256: string | undefined,
    @Res() res: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    try {
      const hash = sha256 || (await this.downloads.current()).sha256;
      if (!this.downloads.isValidHash(hash)) {
        res.status(400).json({ error: { message: 'Invalid APK version' } });
        return;
      }

      const file = await this.downloads.resolveApkFile(hash);
      res.set('Cache-Control', 'public, max-age=86400');
      res.type('application/vnd.android.package-archive');
      res.download(file, 'pawhub-signin-app.apk', (error) => {
        if (error) next(error);
      });
    } catch {
      res.status(404).json({ error: { message: 'Android APK is not available yet' } });
    }
  }
}
