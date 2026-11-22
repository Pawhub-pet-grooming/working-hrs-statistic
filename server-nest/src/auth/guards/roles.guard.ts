import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { apiError } from '../../common/api-error.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { Role } from '../types.js';

/** Runs after SessionAuthGuard; requires `@Roles()` to list the account's role. Allows when no roles are declared. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.account || !required.includes(req.account.role as Role)) {
      throw apiError(403, 'Manager access required');
    }
    return true;
  }
}
