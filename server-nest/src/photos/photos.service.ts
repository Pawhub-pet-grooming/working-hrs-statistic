import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { BACKEND_ROLES, type Account, type Role } from '../auth/types.js';
import { apiError } from '../common/api-error.js';
import { DbService } from '../database/db.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { ScopeService } from '../organization/scope.service.js';
import { localPhotoPath } from './photo-storage.util.js';
import type { UploadPhotoDto } from './photos.schemas.js';

/** Mirrors legacy's `["SHOP", "WORKER", ...backend]` — every account role is an "app account" today. */
const PHOTO_UPLOAD_ROLES: Role[] = ['SHOP', 'WORKER', ...BACKEND_ROLES];
const ALLOWED_FORMATS = ['jpeg', 'png', 'webp'];

interface PhotoRow {
  id: string;
  uploaded_by_account_id: string | null;
  storage_key: string;
  status: string;
  media_type: string | null;
  byte_size: bigint | null;
  shop_id: string | null;
  worker_id: string | null;
  worker_account: string | null;
}

/** Mirrors legacy's photo upload/view routes (server/src/app.js) + `server/src/photo-storage.js`. */
@Injectable()
export class PhotosService {
  private readonly s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

  constructor(
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
    private readonly scope: ScopeService,
  ) {}

  async upload(account: Account, dto: UploadPhotoDto, file: Express.Multer.File | undefined): Promise<{ photoId: string }> {
    if (!PHOTO_UPLOAD_ROLES.includes(account.role as Role)) throw apiError(403, 'App account required');
    if (process.env.PHOTO_STORAGE !== 'local' && !process.env.PHOTO_BUCKET) throw apiError(503, 'Photo storage not configured');
    if (!file) throw apiError(422, 'Photo required');

    const meta = await sharp(file.buffer, { limitInputPixels: 20_000_000 }).metadata();
    if (!meta.format || !ALLOWED_FORMATS.includes(meta.format)) throw apiError(422, 'Unsupported image format');
    await sharp(file.buffer, { limitInputPixels: 20_000_000 }).stats();

    const contentHash = createHash('sha256').update(file.buffer).digest('hex');

    return this.db.$transaction((tx) =>
      this.idempotency.run(tx, account.id, dto.operationId, 'PHOTO', { contentHash }, async () => {
        const id = randomUUID();
        const key = `photos/${account.id}/${dto.operationId}.${meta.format}`;
        const storageKey = process.env.PHOTO_STORAGE === 'local' ? `local:${key}` : key;

        if (process.env.PHOTO_STORAGE === 'local') {
          const filePath = localPhotoPath(storageKey);
          await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
          await writeFile(filePath, file.buffer, { mode: 0o600 });
        } else {
          await this.s3.send(
            new PutObjectCommand({ Bucket: process.env.PHOTO_BUCKET, Key: key, Body: file.buffer, ContentType: `image/${meta.format}`, ServerSideEncryption: 'AES256' }),
          );
        }

        await tx.$executeRaw`
          INSERT INTO photos(id,uploaded_by_account_id,storage_key,status,media_type,byte_size)
          VALUES(${id}::uuid,${account.id}::uuid,${storageKey},'READY',${meta.format},${file.size})`;

        return { photoId: id };
      }),
    );
  }

  /** Mirrors legacy's `readablePhoto()`. Throws if the photo doesn't exist, is out of scope, or isn't currently viewable. */
  async readablePhoto(account: Account, photoId: string): Promise<PhotoRow> {
    const rows = await this.db.$queryRaw<PhotoRow[]>`
      SELECT p.*,r.shop_id,r.worker_id,w.account_id AS worker_account
      FROM photos p LEFT JOIN attendance_records r ON r.photo_id=p.id LEFT JOIN workers w ON w.id=r.worker_id
      WHERE p.id=${photoId}::uuid`;
    const photo = rows[0];
    if (!photo) throw apiError(404, 'Photo unavailable');

    if (photo.shop_id) {
      if (account.role === 'WORKER') {
        if (photo.worker_account !== account.id) throw apiError(403, 'Forbidden');
      } else if (photo.worker_account !== account.id) {
        await this.scope.assertRecordScope(this.db, account, photo.shop_id, photo.worker_id as string);
      }
    } else if (photo.uploaded_by_account_id !== account.id) {
      throw apiError(403, 'Forbidden');
    }

    if (photo.status === 'EXPIRED') throw apiError(410, 'Photo removed after the 3-month retention period', 'PHOTO_EXPIRED');
    if (photo.status !== 'READY') throw apiError(404, 'Photo unavailable');

    return photo;
  }

  async photoUrl(photo: PhotoRow): Promise<{ url: string; requiresAuthentication: true } | { url: string; expiresIn: number }> {
    if (photo.storage_key.startsWith('local:')) return { url: `/api/v1/photos/${photo.id}/file`, requiresAuthentication: true };

    const url = await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: process.env.PHOTO_BUCKET, Key: photo.storage_key }), { expiresIn: 120 });
    return { url, expiresIn: 120 };
  }
}
