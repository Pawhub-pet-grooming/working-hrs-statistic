import type { Express } from 'express';

// Mount this before Nest's own setup: Nest installs a catch-all 404 during init that would
// otherwise shadow legacy routes. A route moved to Nest must be deleted here (server/) too,
// so there's never a live path defined in both apps.
export async function mountLegacyApp(instance: Express): Promise<void> {
  // @ts-expect-error -- plain JS workspace package, no declaration file
  const { app: legacyApp } = await import('../../server/src/app.js');
  instance.use(legacyApp as Express);
}
