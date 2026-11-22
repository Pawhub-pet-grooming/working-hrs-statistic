import { HttpException, StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { mountLegacyApp } from './legacy-gateway.js';

/** Shared by main.ts and the legacy test suite's combined-app bootstrap. */
export async function createApp(options: { logger?: boolean } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: options.logger === false ? false : undefined,
  });

  // Mounted first: Nest adds its own catch-all 404 during init, which would
  // otherwise shadow the legacy app for every route Nest doesn't define.
  await mountLegacyApp(app.getHttpAdapter().getInstance());

  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      errorHttpStatusCode: 422,
      exceptionFactory: (issues) =>
        new HttpException({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request fields', fields: issues } }, 422),
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());

  return app;
}
