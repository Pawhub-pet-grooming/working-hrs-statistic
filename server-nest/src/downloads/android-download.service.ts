import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface AndroidRelease {
  sha256: string;
  sizeBytes: number;
  [key: string]: unknown;
}

/** Mirrors legacy's `server/src/android-download.js`. */
@Injectable()
export class AndroidDownloadService {
  async current(): Promise<AndroidRelease & { downloadPath: string }> {
    const metadata = JSON.parse(await readFile(path.join(this.directory(), 'android.json'), 'utf8')) as AndroidRelease;
    if (!SHA256_PATTERN.test(metadata.sha256)) throw new Error('Invalid APK metadata');

    const file = path.join(this.directory(), metadata.sha256 + '.apk');
    const info = await stat(file);
    if (!info.isFile() || info.size !== metadata.sizeBytes) throw new Error('APK unavailable');

    return { ...metadata, downloadPath: `/api/v1/downloads/android/apk?sha256=${metadata.sha256}` };
  }

  isValidHash(hash: unknown): hash is string {
    return typeof hash === 'string' && SHA256_PATTERN.test(hash);
  }

  async resolveApkFile(hash: string): Promise<string> {
    const file = path.join(this.directory(), hash + '.apk');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('APK unavailable');
    return file;
  }

  private directory(): string {
    return process.env.ANDROID_APK_DIR || fileURLToPath(new URL('../../../server/data/downloads/', import.meta.url));
  }
}
