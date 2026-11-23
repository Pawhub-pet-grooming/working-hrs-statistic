import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createApp } from './bootstrap-app.js';

async function bootstrap(): Promise<void> {
  const app = await createApp();

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
