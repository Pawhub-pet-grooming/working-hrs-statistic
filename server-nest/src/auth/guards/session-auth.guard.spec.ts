import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from '../../database/db.service.js';
import { SessionAuthGuard } from './session-auth.guard.js';

function contextWithHeader(authorization: string | undefined): {
  context: ExecutionContext;
  request: Record<string, unknown>;
} {
  const request: Record<string, unknown> = { headers: { authorization } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('SessionAuthGuard', () => {
  let guard: SessionAuthGuard;
  const findFirst = vi.fn();

  beforeEach(async () => {
    findFirst.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [SessionAuthGuard, { provide: DbService, useValue: { sessions: { findFirst } } }],
    }).compile();
    guard = module.get(SessionAuthGuard);
  });

  it('rejects with 401 when no bearer token is present', async () => {
    const { context } = contextWithHeader(undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the session is not found (expired, revoked, or ineligible account)', async () => {
    findFirst.mockResolvedValue(null);
    const { context } = contextWithHeader('Bearer some-token');
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { error: { message: 'Session expired' } },
    });
  });

  it('attaches the account and session hash, hashing the raw token the same way as the session row', async () => {
    const account = { id: 'account-1', role: 'WORKER', status: 'ACTIVE' };
    findFirst.mockResolvedValue({ accounts: account });
    const { context, request } = contextWithHeader('Bearer raw-token');

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(request.account).toBe(account);
    expect(request.sessionHash).toBe(createHash('sha256').update('raw-token').digest('hex'));
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ token_hash: createHash('sha256').update('raw-token').digest('hex') }),
      }),
    );
  });
});
