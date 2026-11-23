import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AttendanceModule } from './attendance/attendance.module.js';
import { AttendanceExportModule } from './attendance-export/attendance-export.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { envSchema } from './config/env.schema.js';
import { LoggingInterceptor } from './common/logging.interceptor.js';
import { DatabaseModule } from './database/database.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { MeModule } from './me/me.module.js';
import { OrganizationModule } from './organization/organization.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
    }),
    // Mirrors the legacy apiLimiter's 300/60s default; auth routes override it per-endpoint to
    // match the legacy per-route limiters exactly (see AuthController).
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 300 }] }),
    DatabaseModule,
    AuditModule,
    IdempotencyModule,
    OrganizationModule,
    AuthModule,
    MeModule,
    AttendanceModule,
    AttendanceExportModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
