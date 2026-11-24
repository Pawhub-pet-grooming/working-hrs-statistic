import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { apiError } from '../common/api-error.js';

interface StoreRelease {
  objectKey: string;
  [key: string]: unknown;
}

/** Mirrors legacy's `server/src/store-download.js`. */
@Injectable()
export class StoreDownloadService {
  private readonly s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });
  private readonly releaseFile = new URL('../../../releases/store-android-1.0.5-rc2.json', import.meta.url);

  async metadata(): Promise<Record<string, unknown>> {
    const { objectKey: _objectKey, ...rest } = await this.loadRelease();
    return { ...rest, available: Boolean(this.bucket()) };
  }

  async signedDownloadUrl(): Promise<string> {
    if (!this.bucket()) throw apiError(503, 'Store App download is unavailable');
    const release = await this.loadRelease();

    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket()!,
        Key: release.objectKey,
        ResponseContentType: 'application/vnd.android.package-archive',
        ResponseContentDisposition: 'attachment; filename="pawhub-store-v1.0.5-rc2.apk"',
      }),
      { expiresIn: 300 },
    );
  }

  private bucket(): string | undefined {
    return process.env.STORE_APK_BUCKET;
  }

  private async loadRelease(): Promise<StoreRelease> {
    return JSON.parse(await readFile(this.releaseFile, 'utf8')) as StoreRelease;
  }
}
