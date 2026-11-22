import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { IdempotencyService } from './idempotency.service.js';

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  const $executeRaw = vi.fn();
  const findUnique = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const tx = {
    $executeRaw,
    api_operations: { findUnique, create, update },
  } as unknown as Prisma.TransactionClient;

  beforeEach(async () => {
    $executeRaw.mockReset().mockResolvedValue(0);
    findUnique.mockReset();
    create.mockReset();
    update.mockReset().mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({ providers: [IdempotencyService] }).compile();
    service = module.get(IdempotencyService);
  });

  it('runs fn and stores its result on a first-time operationId', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: 'op-1' });
    const fn = vi.fn().mockResolvedValue({ created: true });

    const result = await service.run(tx, 'actor-1', 'op-id-1', 'SHOP_CREATE', { name: 'Shop' }, fn);

    expect(result).toEqual({ created: true });
    expect(fn).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      data: { actor_account_id: 'actor-1', operation_id: 'op-id-1', request_hash: expect.any(String) },
    });
    expect(update).toHaveBeenCalledWith({ where: { id: 'op-1' }, data: { response_data: { created: true } } });
  });

  it('replays the stored response without re-running fn when the hash matches', async () => {
    // First call computes and records the real digest for this (type, body) pair.
    findUnique.mockResolvedValueOnce(null);
    create.mockResolvedValue({ id: 'op-1' });
    await service.run(tx, 'actor-1', 'op-id-2', 'SHOP_CREATE', { name: 'Shop' }, vi.fn().mockResolvedValue({ cached: true }));
    const digestUsed = create.mock.calls[0]![0].data.request_hash as string;

    findUnique.mockResolvedValue({ id: 'op-1', request_hash: digestUsed, response_data: { cached: true } });
    const fn2 = vi.fn();
    const result = await service.run(tx, 'actor-1', 'op-id-2', 'SHOP_CREATE', { name: 'Shop' }, fn2);

    expect(result).toEqual({ cached: true });
    expect(fn2).not.toHaveBeenCalled();
  });

  it('rejects a reused operationId submitted with different data', async () => {
    findUnique.mockResolvedValue({ id: 'op-1', request_hash: 'different-hash', response_data: null });

    const promise = service.run(tx, 'actor-1', 'op-id-3', 'SHOP_CREATE', { name: 'Shop' }, vi.fn());

    await expect(promise).rejects.toBeInstanceOf(HttpException);
    await expect(promise).rejects.toMatchObject({
      response: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    });
  });
});
