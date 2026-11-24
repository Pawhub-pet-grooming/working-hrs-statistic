import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiError } from '../common/api-error.js';

const LOCAL_PHOTO_KEY_PATTERN = /^local:photos\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpeg|png|webp)$/;

/**
 * Mirrors legacy's `server/src/photo-storage.js`. Defaults to the SAME physical directory as
 * legacy (`server/data/photos/`), not a separate `server-nest/data/photos/` — the still-legacy
 * `processPhotoRetention()` background job (server/src/photo-retention.js, run by index.js's
 * maintenance loop) must be able to delete files this app writes, and vice versa.
 */
export function localPhotoPath(key: string): string {
  if (!LOCAL_PHOTO_KEY_PATTERN.test(key)) throw apiError(422, 'Invalid photo storage key', 'INVALID_PHOTO_KEY');
  const directory = process.env.PHOTO_LOCAL_DIR || fileURLToPath(new URL('../../../server/data/photos/', import.meta.url));
  return path.resolve(directory, key.slice('local:photos/'.length));
}
