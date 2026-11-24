import { ShutdownSignal } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createApp } from './bootstrap-app.js';

async function bootstrap(): Promise<void> {
  const app = await createApp();

  // Mirrors legacy's process.on("SIGTERM", ...) in server/src/index.js: only SIGTERM triggers a
  // graceful shutdown here, not every signal in ShutdownSignal (e.g. a dev Ctrl+C/SIGINT keeps
  // behaving like a plain Nest app). Runs onModuleDestroy (DbService disconnects Prisma),
  // beforeApplicationShutdown (the schedule module clears MaintenanceScheduler's ticks), the HTTP
  // server close, then onApplicationShutdown, in that order.
  app.enableShutdownHooks([ShutdownSignal.SIGTERM]);

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
