import type { ValidationPipeOptions } from '@nestjs/common';

/**
 * Global validation options, shared by `main.ts` and the e2e suite so both
 * exercise the same rules. `whitelist` strips undecorated properties and
 * `forbidNonWhitelisted` rejects them outright, which means every property a
 * DTO accepts needs a `class-validator` decorator.
 */
export const validationPipeOptions: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: {
    enableImplicitConversion: true,
  },
};
