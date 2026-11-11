import { readFile } from 'node:fs/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const roles = ['MANAGER', 'GENERAL_MANAGER', 'SUPER_MANAGER'];
const client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const releaseFile = new URL('../../releases/store-android-1.0.5-rc2.json', import.meta.url);

export function mountStoreDownload(app, {
  loadRelease = async () => JSON.parse(await readFile(releaseFile, 'utf8')),
  bucket = () => process.env.STORE_APK_BUCKET,
  sign = command => getSignedUrl(client, command, { expiresIn: 300 }),
} = {}) {
  app.use('/api/v1/manager/downloads/store-android', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.account) return res.status(401).json({ error: { message: 'Sign in required' } });
    if (!roles.includes(req.account.role)) return res.status(403).json({ error: { message: 'Manager access required' } });
    next();
  });
  app.get('/api/v1/manager/downloads/store-android', async (req, res) => {
    const release = await loadRelease();
    const { objectKey, ...metadata } = release;
    res.json({ data: { ...metadata, available: Boolean(bucket()) } });
  });
  app.post('/api/v1/manager/downloads/store-android/link', async (req, res) => {
    if (!bucket()) return res.status(503).json({ error: { message: 'Store App download is unavailable' } });
    const release = await loadRelease();
    const url = await sign(new GetObjectCommand({
      Bucket: bucket(), Key: release.objectKey,
      ResponseContentType: 'application/vnd.android.package-archive',
      ResponseContentDisposition: 'attachment; filename="pawhub-store-v1.0.5-rc2.apk"',
    }));
    res.json({ data: { url } });
  });
}
