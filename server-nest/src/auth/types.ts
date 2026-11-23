import type { accounts } from '../generated/prisma/client.js';

export type Role = 'WORKER' | 'MANAGER' | 'GENERAL_MANAGER' | 'SUPER_MANAGER' | 'SHOP';
export type Account = accounts;

/** Mirrors legacy's `backend` role array (server/src/app.js). */
export const BACKEND_ROLES: Role[] = ['MANAGER', 'GENERAL_MANAGER', 'SUPER_MANAGER'];

/** Mirrors legacy's `["WORKER", ...backend]` role union — personal (self-service) app accounts. */
export const PERSONAL_ROLES: Role[] = ['WORKER', ...BACKEND_ROLES];

declare global {
  namespace Express {
    interface Request {
      account?: Account;
      sessionHash?: string;
    }
  }
}
