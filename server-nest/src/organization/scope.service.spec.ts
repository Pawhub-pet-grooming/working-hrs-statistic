import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import type { Account } from '../auth/types.js';
import type { DbService } from '../database/db.service.js';
import { ScopeService } from './scope.service.js';

describe('ScopeService', () => {
  let service: ScopeService;
  const shopsCount = vi.fn();
  const accountShopsCount = vi.fn();
  const managerWorkersCount = vi.fn();
  const workersCount = vi.fn();
  const c = {
    shops: { count: shopsCount },
    account_shops: { count: accountShopsCount },
    manager_workers: { count: managerWorkersCount },
    workers: { count: workersCount },
  } as unknown as DbService;

  const account = (role: Account['role']): Account => ({ id: 'account-1', role }) as Account;

  beforeEach(async () => {
    shopsCount.mockReset();
    accountShopsCount.mockReset();
    managerWorkersCount.mockReset();
    workersCount.mockReset();

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

  it('isCompanyAdmin is true only for GENERAL_MANAGER/SUPER_MANAGER', () => {
    expect(service.isCompanyAdmin(account('GENERAL_MANAGER'))).toBe(true);
    expect(service.isCompanyAdmin(account('SUPER_MANAGER'))).toBe(true);
    expect(service.isCompanyAdmin(account('MANAGER'))).toBe(false);
    expect(service.isCompanyAdmin(account('WORKER'))).toBe(false);
  });

  it('assertWorker allows company admins without a lookup', async () => {
    await expect(service.assertWorker(c, account('SUPER_MANAGER'), 'worker-1')).resolves.toBeUndefined();
    expect(managerWorkersCount).not.toHaveBeenCalled();
  });

  it('assertWorker throws WORKER_FORBIDDEN when the manager does not manage that worker', async () => {
    managerWorkersCount.mockResolvedValue(0);
    const promise = service.assertWorker(c, account('MANAGER'), 'worker-1');
    await expect(promise).rejects.toMatchObject({ response: { error: { code: 'WORKER_FORBIDDEN' } } });
    expect(managerWorkersCount).toHaveBeenCalledWith({ where: { manager_account_id: 'account-1', worker_id: 'worker-1' } });
  });

  it('assertWorker resolves when the manager manages that worker', async () => {
    managerWorkersCount.mockResolvedValue(1);
    await expect(service.assertWorker(c, account('MANAGER'), 'worker-1')).resolves.toBeUndefined();
  });

  it('assertRecordScope resolves for a backend account editing its own worker row, without a shop/manager lookup', async () => {
    workersCount.mockResolvedValue(1);
    await expect(service.assertRecordScope(c, account('MANAGER'), 'shop-1', 'worker-1')).resolves.toBeUndefined();
    expect(workersCount).toHaveBeenCalledWith({ where: { id: 'worker-1', account_id: 'account-1' } });
    expect(accountShopsCount).not.toHaveBeenCalled();
    expect(managerWorkersCount).not.toHaveBeenCalled();
  });

  it('assertRecordScope falls back to allowed() when the account does not own that worker row', async () => {
    workersCount.mockResolvedValue(0);
    accountShopsCount.mockResolvedValue(1);
    await expect(service.assertRecordScope(c, account('MANAGER'), 'shop-1', 'worker-1')).resolves.toBeUndefined();
  });

  it('assertRecordScope falls back to assertWorker() when neither self-ownership nor shop scope match', async () => {
    workersCount.mockResolvedValue(0);
    accountShopsCount.mockResolvedValue(0);
    managerWorkersCount.mockResolvedValue(1);
    await expect(service.assertRecordScope(c, account('MANAGER'), 'shop-1', 'worker-1')).resolves.toBeUndefined();
  });

  it('assertRecordScope throws WORKER_FORBIDDEN when none of the three checks pass', async () => {
    workersCount.mockResolvedValue(0);
    accountShopsCount.mockResolvedValue(0);
    managerWorkersCount.mockResolvedValue(0);
    const promise = service.assertRecordScope(c, account('MANAGER'), 'shop-1', 'worker-1');
    await expect(promise).rejects.toMatchObject({ response: { error: { code: 'WORKER_FORBIDDEN' } } });
  });

  it('assertRecordScope skips the self-worker check entirely for non-backend roles', async () => {
    shopsCount.mockResolvedValue(1);
    await expect(service.assertRecordScope(c, account('SHOP'), 'shop-1', 'worker-1')).resolves.toBeUndefined();
    expect(workersCount).not.toHaveBeenCalled();
  });
});
