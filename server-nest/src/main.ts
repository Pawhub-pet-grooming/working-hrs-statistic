import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { mountLegacyApp } from './legacy-gateway.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Mounted first: Nest adds its own catch-all 404 during init, which would
  // otherwise shadow the legacy app for every route Nest doesn't define.
  await mountLegacyApp(app.getHttpAdapter().getInstance());

  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.useGlobalFilters(new HttpErrorFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('PawHub API')
    .setDescription('NestJS migration target. Routes not yet migrated fall through to the legacy Express app.')
    .setVersion('0.1')
    .build();
  const documentFactory = () => {
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    document.paths['/docs-json'] = {
      get: { summary: 'This OpenAPI document', responses: { '200': { description: 'The document' } } },
    };
    return document;
  };
  SwaggerModule.setup('docs', app, documentFactory);

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
