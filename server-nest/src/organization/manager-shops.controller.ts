import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { BACKEND_ROLES, type Account } from '../auth/types.js';
import { ShopsService } from './shops.service.js';
import {
  createShopSchema,
  shopProfileSchema,
  uuidParamSchema,
  type CreateShopDto,
  type ShopProfileDto,
} from './shops.schemas.js';

/** Mirrors legacy's blanket `app.use("/api/v1/manager", manager)` role gate — every route here requires a backend role. */
@Controller('api/v1/manager/shops')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class ManagerShopsController {
  constructor(private readonly shops: ShopsService) {}

  @Get()
  async list(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.shops.list(account, false) };
  }

  @Post()
  @Roles('GENERAL_MANAGER', 'SUPER_MANAGER')
  async create(
    @CurrentAccount() account: Account,
    @Body({ schema: createShopSchema }) dto: CreateShopDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.shops.create(account, dto) };
  }

  @Post(':id/profile')
  @HttpCode(200)
  async updateProfile(
    @CurrentAccount() account: Account,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: shopProfileSchema }) dto: ShopProfileDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.shops.updateProfile(account, id, dto) };
  }
}
