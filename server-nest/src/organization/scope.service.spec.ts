import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import type { Account } from '../auth/types.js';
import type { DbService } from '../database/db.service.js';
import { ScopeService } from './scope.service.js';

describe('ScopeService', () => {
  let service: ScopeService;
  const shopsCount = vi.fn();
  const accountShopsCount = vi.fn();
  const c = { shops: { count: shopsCount }, account_shops: { count: accountShopsCount } } as unknown as DbService;

  const account = (role: Account['role']): Account => ({ id: 'account-1', role }) as Account;

  beforeEach(async () => {
    shopsCount.mockReset();
    accountShopsCount.mockReset();
    const module: TestingModule = await Test.createTestingModule({ providers: [ScopeService] }).compile();
    service = module.get(ScopeService);
  });

  it('allows company admins (GENERAL_MANAGER/SUPER_MANAGER) into any shop without a lookup', async () => {
    expect(await service.allowed(c, account('GENERAL_MANAGER'), 'shop-1')).toBe(true);
    expect(await service.allowed(c, account('SUPER_MANAGER'), 'shop-1')).toBe(true);
    expect(shopsCount).not.toHaveBeenCalled();
    expect(accountShopsCount).not.toHaveBeenCalled();
  });

  it('checks shops.account_id for a SHOP-role account rather than account_shops', async () => {
    shopsCount.mockResolvedValue(1);
    expect(await service.allowed(c, account('SHOP'), 'shop-1')).toBe(true);
    expect(shopsCount).toHaveBeenCalledWith({ where: { id: 'shop-1', account_id: 'account-1' } });
    expect(accountShopsCount).not.toHaveBeenCalled();
  });

  it('checks account_shops for a MANAGER account', async () => {
    accountShopsCount.mockResolvedValue(0);
    expect(await service.allowed(c, account('MANAGER'), 'shop-1')).toBe(false);
    expect(accountShopsCount).toHaveBeenCalledWith({ where: { shop_id: 'shop-1', account_id: 'account-1' } });
  });

  it('assertShop throws SHOP_FORBIDDEN when the account is out of scope', async () => {
    accountShopsCount.mockResolvedValue(0);
    const promise = service.assertShop(c, account('MANAGER'), 'shop-1');
    await expect(promise).rejects.toBeInstanceOf(HttpException);
    await expect(promise).rejects.toMatchObject({ response: { error: { code: 'SHOP_FORBIDDEN' } } });
  });

  it('assertShop resolves without throwing when the account is in scope', async () => {
    accountShopsCount.mockResolvedValue(1);
    await expect(service.assertShop(c, account('MANAGER'), 'shop-1')).resolves.toBeUndefined();
  });
});
