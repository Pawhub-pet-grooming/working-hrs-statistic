import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { BACKEND_ROLES, type Account } from '../auth/types.js';
import { AccountsService } from './accounts.service.js';
import {
  approveAccountSchema,
  createAccountSchema,
  managedProfileSchema,
  removeAccountSchema,
  resendInvitationSchema,
  type ApproveAccountDto,
  type CreateAccountDto,
  type ManagedProfileDto,
  type RemoveAccountDto,
  type ResendInvitationDto,
} from './accounts.schemas.js';
import { uuidParamSchema } from './shops.schemas.js';

/** Mirrors legacy's blanket `app.use("/api/v1/manager", manager)` role gate — every route here requires a backend role. */
@Controller('api/v1/manager')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...BACKEND_ROLES)
export class ManagerAccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('workers')
  async listWorkers(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.accounts.listWorkers(account) };
  }

  @Get('managers')
  @Roles('GENERAL_MANAGER', 'SUPER_MANAGER')
  async listManagers(): Promise<{ data: unknown }> {
    return { data: await this.accounts.listManagers() };
  }

  @Post('workers')
  async createWorker(
    @CurrentAccount() account: Account,
    @Body({ schema: createAccountSchema }) dto: CreateAccountDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.accounts.create(account, dto, false) };
  }

  @Post('managers')
  @Roles('GENERAL_MANAGER', 'SUPER_MANAGER')
  async createManager(
    @CurrentAccount() account: Account,
    @Body({ schema: createAccountSchema }) dto: CreateAccountDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.accounts.create(account, dto, true) };
  }

  @Post('accounts/:id/profile')
  @HttpCode(200)
  async updateProfile(
    @CurrentAccount() account: Account,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: managedProfileSchema }) dto: ManagedProfileDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.accounts.updateManagedProfile(account, id, dto) };
  }

  @Post('accounts/:id/remove')
  @HttpCode(200)
  async remove(
    @CurrentAccount() account: Account,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: removeAccountSchema }) dto: RemoveAccountDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.accounts.remove(account, id, dto) };
  }

  @Post('accounts/:id/approve')
  @HttpCode(200)
  @Roles('GENERAL_MANAGER')
  async approve(
    @CurrentAccount() account: Account,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: approveAccountSchema }) dto: ApproveAccountDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.accounts.approve(account, id, dto) };
  }

  @Post('accounts/:id/invitations')
  @HttpCode(200)
  async resendInvitation(
    @CurrentAccount() account: Account,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: resendInvitationSchema }) dto: ResendInvitationDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.accounts.resendInvitation(account, id, dto) };
  }

  @Get('invitations')
  async listInvitations(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.accounts.listInvitations(account) };
  }
}
