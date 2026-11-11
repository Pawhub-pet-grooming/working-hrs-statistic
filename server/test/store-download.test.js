import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountStoreDownload } from '../src/store-download.js';

test('Store APK metadata and download links require a management role', async () => {
  const app = express();
  app.use((req, res, next) => { if (req.headers['x-test-role']) req.account = { role: req.headers['x-test-role'] }; next(); });
  const calls = [];
  let configured = true;
  mountStoreDownload(app, {
    bucket: () => configured ? 'private-store-apps' : undefined,
    loadRelease: async () => ({ releaseName: '1.0.5-rc2', objectKey: 'store-releases/pawhub-v1.0.5-rc2.apk', sha256: 'a'.repeat(64) }),
    sign: async command => { calls.push(command.input); return 'https://example.test/short-lived-download'; },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/manager/downloads/store-android`;
  try {
    for (const [role, status] of [[null, 401], ['WORKER', 403], ['SHOP', 403]]) {
      const headers = role ? { 'x-test-role': role } : {};
      assert.equal((await fetch(base, { headers })).status, status);
      assert.equal((await fetch(base + '/link', { method: 'POST', headers })).status, status);
    }
    assert.equal(calls.length, 0);
    for (const role of ['MANAGER', 'GENERAL_MANAGER', 'SUPER_MANAGER']) {
      const headers = { 'x-test-role': role };
      const metadata = await fetch(base, { headers });
      assert.equal(metadata.headers.get('cache-control'), 'no-store');
      const { data } = await metadata.json();
      assert.equal(data.releaseName, '1.0.5-rc2');
      assert.equal(data.available, true);
      assert.equal(data.objectKey, undefined);
      const result = await fetch(base + '/link', { method: 'POST', headers });
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal((await result.json()).data.url, 'https://example.test/short-lived-download');
    }
    assert.equal(calls.length, 3);
    assert.equal(calls[0].Bucket, 'private-store-apps');
    assert.equal(calls[0].Key, 'store-releases/pawhub-v1.0.5-rc2.apk');
    configured = false;
    assert.equal((await (await fetch(base, { headers: { 'x-test-role': 'MANAGER' } })).json()).data.available, false);
    assert.equal((await fetch(base + '/link', { method: 'POST', headers: { 'x-test-role': 'MANAGER' } })).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
