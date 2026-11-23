import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { apiError } from '../common/api-error.js';
import { AuthService } from './auth.service.js';
import {
  changePasswordSchema,
  consumePasswordLinkSchema,
  loginSchema,
  registerSchema,
  requestPasswordLinkSchema,
  type ChangePasswordDto,
  type ConsumePasswordLinkDto,
  type LoginDto,
  type RegisterDto,
  type RequestPasswordLinkDto,
} from './auth.schemas.js';
import { CurrentAccount } from './decorators/current-account.decorator.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';
import type { Account } from './types.js';

@Controller('api/v1')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/login')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 900_000 } })
  async login(@Body({ schema: loginSchema }) dto: LoginDto): Promise<{ data: unknown }> {
    return { data: await this.auth.login(dto, false) };
  }

  @Post('manager/auth/login')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 900_000 } })
  async managerLogin(@Body({ schema: loginSchema }) dto: LoginDto): Promise<{ data: unknown }> {
    return { data: await this.auth.login(dto, true) };
  }

  @Post('auth/register')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  async register(@Body({ schema: registerSchema }) dto: RegisterDto): Promise<{ data: unknown }> {
    // Does not reveal whether this address already belongs to an account.
    await this.auth.register(dto);

    return { data: { accepted: true } };
  }

  @Post('auth/password-links')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  async requestPasswordLink(
    @Body({ schema: requestPasswordLinkSchema }) dto: RequestPasswordLinkDto,
  ): Promise<{ data: unknown }> {
    await this.auth.requestPasswordLink(dto);

    return { data: { accepted: true } };
  }

  @Post('auth/password-links/consume')
  @HttpCode(200)
  async consumePasswordLink(
    @Body({ schema: consumePasswordLinkSchema }) dto: ConsumePasswordLinkDto,
  ): Promise<{ data: unknown }> {
    return { data: await this.auth.consumePasswordLink(dto) };
  }

  @Post('auth/logout')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async logout(@Req() req: Request): Promise<{ data: unknown }> {
    await this.auth.logout(req.sessionHash as string);

    return { data: { loggedOut: true } };
  }

  @Post('me/password')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  async changePassword(@CurrentAccount() account: Account, @Body() body: unknown): Promise<{ data: unknown }> {
    // The SHOP-fixed-password check must run before body validation, exactly like the legacy handler.
    if (account.role === 'SHOP') throw apiError(403, 'Shop accounts use the fixed login password', 'SHOP_FIXED_PASSWORD');

    const result = changePasswordSchema.safeParse(body);
    if (!result.success) throw apiError(422, 'Invalid request fields', 'VALIDATION_ERROR');

    const dto: ChangePasswordDto = result.data;
    await this.auth.changePassword(account, dto);

    return { data: { changed: true, requiresLogin: true } };
  }
}
