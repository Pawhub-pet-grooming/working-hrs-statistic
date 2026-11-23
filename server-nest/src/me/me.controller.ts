import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { Account } from '../auth/types.js';
import { MeService } from './me.service.js';
import { preferencesSchema, profileSchema, type PreferencesDto, type ProfileDto } from './me.schemas.js';

@Controller('api/v1/me')
@UseGuards(SessionAuthGuard)
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  async info(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.me.info(account) };
  }

  @Post('preferences')
  @HttpCode(200)
  async preferences(
    @CurrentAccount() account: Account,
    @Body({ schema: preferencesSchema }) dto: PreferencesDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.me.updatePreferences(account, dto) };
  }

  @Get('stores')
  async stores(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.me.stores(account) };
  }

  @Get('profile')
  async getProfile(@CurrentAccount() account: Account): Promise<{ data: unknown }> {
    return { data: await this.me.profile(account) };
  }

  @Post('profile')
  @HttpCode(200)
  async updateProfile(
    @CurrentAccount() account: Account,
    @Body({ schema: profileSchema }) dto: ProfileDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.me.updateProfile(account, dto) };
  }
}
