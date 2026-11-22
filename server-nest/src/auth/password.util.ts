// Reuses the legacy implementation so the SHOP fixed-password rule has one source of truth
// while shop creation (server/src/app.js) hasn't been migrated yet.
// @ts-expect-error -- plain JS workspace package, no declaration file
export { SHOP_LOGIN_PASSWORD, passwordMatches } from '../../../server/src/shop-password.js';
