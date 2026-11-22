import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { RolesGuard } from './roles.guard.js';

function contextWithAccount(role: string | undefined): ExecutionContext {
  const request = role ? { account: { role } } : {};
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => (): void => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({ providers: [RolesGuard] }).compile();
    guard = module.get(RolesGuard);
    reflector = module.get(Reflector);
  });

  it('allows the request when the route declares no @Roles()', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(contextWithAccount('WORKER'))).toBe(true);
  });

  it('allows the request when the account role is in the required list', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['MANAGER', 'GENERAL_MANAGER', 'SUPER_MANAGER']);
    expect(guard.canActivate(contextWithAccount('GENERAL_MANAGER'))).toBe(true);
  });

  it('rejects with 403 when the account role is not in the required list', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['MANAGER', 'GENERAL_MANAGER', 'SUPER_MANAGER']);
    try {
      guard.canActivate(contextWithAccount('WORKER'));
      expect.unreachable('expected canActivate to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(403);
    }
  });

  it('rejects when no account is attached to the request', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['MANAGER']);
    expect(() => guard.canActivate(contextWithAccount(undefined))).toThrow(HttpException);
  });
});
