import type { Server } from 'node:http';
import { createApp } from '../bootstrap-app.js';

/**
 * Boots the same app main.ts does (Nest routes + the legacy Express app mounted as a
 * fallback) and returns its underlying HTTP server, unstarted (call `.listen()` on it).
 * Used by `server/test/*.test.js` so the migration's acceptance suite exercises requests
 * through whichever app actually serves each route, exactly like production.
 */
export async function createCombinedTestServer(): Promise<Server> {
  const app = await createApp({ logger: false });
  await app.init();
  return app.getHttpServer();
}
