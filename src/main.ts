import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import { clerkMiddleware } from '@clerk/express';

import { AppModule } from './app.module.js';
import { validationPipeOptions } from './validation.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';
  const frontendBaseUrl =
    configService.get<string>('FRONTEND_BASE_URL') || 'http://localhost:3001';

  app.enableCors({ origin: frontendBaseUrl });
  app.setGlobalPrefix('api/v1');
  app.use(clerkMiddleware());
  app.useGlobalPipes(new ValidationPipe(validationPipeOptions));

  if (!isProduction) {
    const config = new DocumentBuilder()
      .setTitle('Worth Knowing API')
      .setDescription('API documentation for Worth Knowing')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    const options = {
      operationIdFactory: (controllerKey: string, methodKey: string) =>
        `${controllerKey}_${methodKey}`,
    };

    const documentFactory = () =>
      SwaggerModule.createDocument(app, config, options);

    SwaggerModule.setup('api/v1/documentation', app, documentFactory);
  }

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
