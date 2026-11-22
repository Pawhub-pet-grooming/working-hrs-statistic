import type { accounts } from '../generated/prisma/client.js';

export type Role = 'WORKER' | 'MANAGER' | 'GENERAL_MANAGER' | 'SUPER_MANAGER' | 'SHOP';
export type Account = accounts;

declare global {
  namespace Express {
    interface Request {
      account?: Account;
      sessionHash?: string;
    }
  }
}
