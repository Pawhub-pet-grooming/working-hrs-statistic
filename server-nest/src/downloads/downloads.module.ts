import { Module } from '@nestjs/common';
import { AndroidDownloadController } from './android-download.controller.js';
import { AndroidDownloadService } from './android-download.service.js';
import { StoreDownloadController } from './store-download.controller.js';
import { StoreDownloadService } from './store-download.service.js';

@Module({
  controllers: [AndroidDownloadController, StoreDownloadController],
  providers: [AndroidDownloadService, StoreDownloadService],
})
export class DownloadsModule {}
