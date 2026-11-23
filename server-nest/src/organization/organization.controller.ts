import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { Account } from '../auth/types.js';
import {
  generalManagerSchema,
  permissionsSchema,
  roleChangeSchema,
  type GeneralManagerDto,
  type PermissionsDto,
  type RoleChangeDto,
} from './organization.schemas.js';
import { OrganizationService } from './organization.service.js';

/** Mirrors legacy's org-wide routes (server/src/organization.js) — gated by its `admin()` helper to company administrators only. */
@Controller('api/v1/manager/organization')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles('GENERAL_MANAGER', 'SUPER_MANAGER')
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Get()
  async getState(): Promise<{ data: unknown }> {
    return { data: await this.organization.getState() };
  }

  @Post('permissions')
  @HttpCode(200)
  async setPermissions(
    @CurrentAccount() account: Account,
    @Body({ schema: permissionsSchema }) dto: PermissionsDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.organization.setPermissions(account, dto) };
  }

  /** Mirrors legacy's narrower check on this one route: SUPER_MANAGER (Owner) only, not GENERAL_MANAGER. */
  @Post('general-manager')
  @HttpCode(200)
  @Roles('SUPER_MANAGER')
  async appointGeneralManager(
    @CurrentAccount() account: Account,
    @Body({ schema: generalManagerSchema }) dto: GeneralManagerDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.organization.appointGeneralManager(account, dto) };
  }

  @Post('role')
  @HttpCode(200)
  async changeRole(
    @CurrentAccount() account: Account,
    @Body({ schema: roleChangeSchema }) dto: RoleChangeDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.organization.changeRole(account, dto) };
  }
}
