import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  let service: AuditService;
  const create = vi.fn();
  const tx = { audit_logs: { create } } as unknown as Prisma.TransactionClient;

  beforeEach(async () => {
    create.mockReset().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({ providers: [AuditService] }).compile();
    service = module.get(AuditService);
  });

  it('inserts an audit_logs row with the given actor, action and resource', async () => {
    await service.record(tx, 'actor-1', 'PASSWORD_CHANGE', 'actor-1');
    expect(create).toHaveBeenCalledWith({
      data: {
        actor_account_id: 'actor-1',
        action: 'PASSWORD_CHANGE',
        resource_id: 'actor-1',
        before_data: Prisma.DbNull,
        after_data: Prisma.DbNull,
      },
    });
  });

  it('stores before/after snapshots as JSON values rather than the DbNull sentinel', async () => {
    await service.record(tx, 'actor-1', 'PROFILE_UPDATE', 'actor-1', { name: 'old' }, { name: 'new' });
    expect(create).toHaveBeenCalledWith({
      data: {
        actor_account_id: 'actor-1',
        action: 'PROFILE_UPDATE',
        resource_id: 'actor-1',
        before_data: { name: 'old' },
        after_data: { name: 'new' },
      },
    });
  });
});
