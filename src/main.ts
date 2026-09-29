import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import { clerkMiddleware } from '@clerk/express';

import { AppModule } from './app.module.js';
import { validationPipeOptions } from './validation.js';

/**
 * Warns when the Clerk webhook cannot possibly be working.
 *
 * `ClerkAuthGuard` is create-only by design — it provisions a user on their
 * first authenticated request and never revisits them — so `name`, `email` and
 * `imageUrl` are refreshed *only* by the `user.updated` webhook. Nothing else
 * keeps them current, and nothing else fails if it stops.
 *
 * That makes a misconfigured webhook invisible: every event fails signature
 * verification, the endpoint 400s, and the only symptom is a display name that
 * quietly stopped updating. Worth a line at boot.
 *
 * Checks the secret only. It cannot know whether the webhook URL is actually
 * reachable from Clerk's servers — a tunnel being down is the other common
 * cause and is invisible from here — so this narrows the diagnosis rather than
 * ruling it out.
 */
function warnAboutWebhookConfig(configService: ConfigService) {
  const secret = configService.get<string>('CLERK_WEBHOOK_SIGNING_SECRET');

  if (!secret) {
    console.warn(
      '\n  ⚠  CLERK_WEBHOOK_SIGNING_SECRET is not set.\n' +
        '     Clerk-owned fields (name, email, imageUrl) will never update after a\n' +
        '     user is created — the guard is create-only and the webhook is the only\n' +
        '     writer. Repair an existing user with: pnpm user:sync <clerk-user-id>\n',
    );
    return;
  }

  // The value shipped in `.env.local.example`. Copied verbatim and left in
  // place, which is the realistic way this goes wrong.
  if (secret.includes('your_webhook_signing_secret')) {
    console.warn(
      '\n  ⚠  CLERK_WEBHOOK_SIGNING_SECRET is still the placeholder from\n' +
        '     .env.local.example, so every webhook will fail verification.\n' +
        '     Copy the real value from Clerk Dashboard → Webhooks → Signing Secret.\n' +
        '     Repair an existing user with: pnpm user:sync <clerk-user-id>\n',
    );
  }
}

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

  warnAboutWebhookConfig(configService);

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
