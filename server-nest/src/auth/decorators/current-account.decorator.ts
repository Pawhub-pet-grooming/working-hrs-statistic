import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Account } from '../types.js';

export const CurrentAccount = createParamDecorator((_: unknown, ctx: ExecutionContext): Account => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.account as Account;
});
