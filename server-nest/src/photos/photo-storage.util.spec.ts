import { localPhotoPath } from './photo-storage.util.js';

describe('localPhotoPath', () => {
  const accountId = '11111111-1111-1111-1111-111111111111';
  const operationId = '22222222-2222-2222-2222-222222222222';

  it('resolves a well-formed local key under the configured directory', () => {
    const resolved = localPhotoPath(`local:photos/${accountId}/${operationId}.jpeg`);
    expect(resolved.endsWith(`photos/${accountId}/${operationId}.jpeg`)).toBe(true);
  });

  it('rejects keys that are not the local:photos/<uuid>/<uuid>.<format> shape', () => {
    for (const key of [
      `photos/${accountId}/${operationId}.jpeg`,
      `local:photos/${accountId}/${operationId}.gif`,
      `local:photos/not-a-uuid/${operationId}.jpeg`,
      'local:../../etc/passwd',
    ]) {
      expect(() => localPhotoPath(key)).toThrow();
    }
  });
});
