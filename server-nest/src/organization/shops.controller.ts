import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { Account } from '../auth/types.js';
import { fourDigitCodeParamSchema } from './shops.schemas.js';
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

  /** Mirrors legacy's SHOP-only employee lookup, used by the shop app before clocking someone in. */
  @Get(':shopId/employees/:workerId')
  @UseGuards(RolesGuard)
  @Roles('SHOP')
  async lookupEmployee(
    @CurrentAccount() account: Account,
    @Param('shopId', { schema: fourDigitCodeParamSchema }) shopId: string,
    @Param('workerId', { schema: fourDigitCodeParamSchema }) workerId: string,
  ): Promise<{ data: unknown }> {
    return { data: await this.shops.lookupEmployee(account, shopId, workerId) };
  }
}
