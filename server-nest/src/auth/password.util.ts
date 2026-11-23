import argon2 from 'argon2';
import type { Account } from './types.js';

/** Mirrors legacy's server/src/shop-password.js: every SHOP account shares this one fixed password. */
export const SHOP_LOGIN_PASSWORD = '123456';

export async function passwordMatches(account: Account, password: string): Promise<boolean> {
  if (account.role === 'SHOP') return password === SHOP_LOGIN_PASSWORD;
  return !!account.password_hash && (await argon2.verify(account.password_hash, password));
}
