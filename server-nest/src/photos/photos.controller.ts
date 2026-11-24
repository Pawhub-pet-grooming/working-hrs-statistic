import { Body, Controller, Get, Param, Post, Res, UseFilters, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { Account } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import { MulterErrorFilter } from './multer-error.filter.js';
import { localPhotoPath } from './photo-storage.util.js';
import { photoIdParamSchema, uploadPhotoSchema, type UploadPhotoDto } from './photos.schemas.js';
import { PhotosService } from './photos.service.js';

/** Mirrors legacy's `/api/v1/photos*` routes (server/src/app.js). */
@Controller('api/v1/photos')
@UseGuards(SessionAuthGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post()
  @UseFilters(MulterErrorFilter)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async upload(
    @CurrentAccount() account: Account,
    @Body({ schema: uploadPhotoSchema }) dto: UploadPhotoDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ data: unknown }> {
    return { data: await this.photos.upload(account, dto, file) };
  }

  @Get(':id/file')
  async file(@CurrentAccount() account: Account, @Param('id', { schema: photoIdParamSchema }) id: string, @Res() res: Response): Promise<void> {
    const photo = await this.photos.readablePhoto(account, id);
    if (!photo.storage_key.startsWith('local:')) throw apiError(404, 'Local photo unavailable');

    res.set('Cache-Control', 'private, no-store');
    res.type(photo.media_type === 'jpeg' ? 'image/jpeg' : `image/${photo.media_type}`);
    res.sendFile(localPhotoPath(photo.storage_key));
  }

  @Get(':id')
  async get(@CurrentAccount() account: Account, @Param('id', { schema: photoIdParamSchema }) id: string): Promise<{ data: unknown }> {
    const photo = await this.photos.readablePhoto(account, id);
    return { data: await this.photos.photoUrl(photo) };
  }
}
