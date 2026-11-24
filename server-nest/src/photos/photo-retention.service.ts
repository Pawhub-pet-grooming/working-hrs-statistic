import { unlink } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DbService } from '../database/db.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { localPhotoPath } from './photo-storage.util.js';

interface PhotoCandidateIdRow {
  id: string;
}

interface PhotoRow {
  id: string;
  storage_key: string;
  status: string;
  created_at: Date | null;
}

export interface PhotoRetentionResult {
  deleted: number;
  failed: number;
  skipped: number;
  scanned: number;
}

export interface PhotoRetentionOptions {
  batchSize?: number;
  removeLocal?: (path: string) => Promise<void>;
  s3Client?: { send: (command: DeleteObjectCommand) => Promise<unknown> };
  bucket?: string;
}

/** `photos.created_at` past the 3-month retention window — mirrors legacy's `due` constant. */
const RETENTION_DUE_SQL = Prisma.sql`created_at <= ((now() AT TIME ZONE 'Pacific/Auckland') - interval '3 months') AT TIME ZONE 'Pacific/Auckland'`;

/**
 * Mirrors legacy's `processPhotoRetention()` (server/src/photo-retention.js). A background
 * batch job, not an HTTP route — not yet wired to a live scheduler, same as
 * `AttendanceExportService`: legacy's `setInterval` in `server/src/index.js` still owns the
 * real retention sweep until Epic 4 introduces `@nestjs/schedule` and cuts the process over.
 */
@Injectable()
export class PhotoRetentionService {
  private readonly s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

  constructor(private readonly db: DbService) {}

  async processPhotoRetention(options: PhotoRetentionOptions = {}): Promise<PhotoRetentionResult> {
    const batchSize = options.batchSize ?? 200;
    const removeLocal = options.removeLocal ?? unlink;
    const s3Client = options.s3Client ?? this.s3;
    const bucket = options.bucket ?? process.env.PHOTO_BUCKET;

    const candidates = await this.db.$queryRaw<PhotoCandidateIdRow[]>`
      SELECT id FROM photos WHERE status='READY' AND ${RETENTION_DUE_SQL} ORDER BY created_at,id LIMIT ${batchSize}`;

    const result: PhotoRetentionResult = { deleted: 0, failed: 0, skipped: 0, scanned: candidates.length };

    for (const candidate of candidates) {
      try {
        const deleted = await this.db.$transaction(async (tx) => {
          const [photo] = await tx.$queryRaw<PhotoRow[]>`
            SELECT * FROM photos WHERE id=${candidate.id}::uuid AND status='READY' AND ${RETENTION_DUE_SQL} FOR UPDATE SKIP LOCKED`;
          if (!photo) return false;

          if (photo.storage_key.startsWith('local:')) {
            try {
              await removeLocal(localPhotoPath(photo.storage_key));
            } catch (error) {
              if ((error as { code?: string }).code !== 'ENOENT') throw error;
            }
          } else {
            if (!bucket) throw Object.assign(new Error('Photo bucket not configured'), { code: 'PHOTO_BUCKET_MISSING' });
            await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: photo.storage_key }));
          }

          await tx.$executeRaw`UPDATE photos SET status='EXPIRED',deleted_at=now() WHERE id=${photo.id}::uuid`;
          await tx.audit_logs.create({
            data: {
              action: 'PHOTO_EXPIRED',
              resource_id: photo.id,
              before_data: { status: 'READY', createdAt: photo.created_at } as unknown as Prisma.InputJsonValue,
              after_data: { status: 'EXPIRED', retentionMonths: 3 },
            },
          });
          return true;
        });

        if (deleted) result.deleted++;
        else result.skipped++;
      } catch (error) {
        result.failed++;
        const err = error as { code?: string; name?: string };
        console.error('Photo retention failed', candidate.id, err.code || err.name);
      }
    }

    return result;
  }
}
