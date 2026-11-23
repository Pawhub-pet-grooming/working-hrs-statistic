import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { Account } from '../auth/types.js';
import { ShopsService } from './shops.service.js';

/** The unscoped `/api/v1/shops` listing — open to any authenticated role (see ShopsService.list). */
@Controller('api/v1/shops')
@UseGuards(SessionAuthGuard)
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  @Get()
  async list(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.shops.list(account, true) };
  }
}
