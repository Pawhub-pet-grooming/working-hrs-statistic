import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { apiError } from '../common/api-error.js';

/** Ports the legacy `encrypt()` helper used to store password-link emails as an encrypted payload. */
export function encryptMailPayload(data: unknown, encryptionKeyHex: string | undefined): string {
  const key = Buffer.from(encryptionKeyHex || '', 'hex');
  if (key.length !== 32) throw apiError(503, 'Mail encryption key not configured', 'MAIL_NOT_CONFIGURED');

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);

  return [iv, cipher.getAuthTag(), enc].map((x) => x.toString('base64')).join('.');
}

/** Ports the legacy `mail.js` decrypt step used to read a queued email job's payload. */
export function decryptMailPayload(encryptedPayload: string, encryptionKeyHex: string | undefined): unknown {
  const [iv, tag, enc] = encryptedPayload.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKeyHex || '', 'hex'), iv!);
  d.setAuthTag(tag!);

  return JSON.parse(Buffer.concat([d.update(enc!), d.final()]).toString());
}
