import {
  ExecutionContext,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { getAuth } from '@clerk/express';
import type { Request } from 'express';

/**
 * Injects the Clerk user ID of the caller.
 *
 * Only usable on routes behind `ClerkAuthGuard`, which rejects anonymous
 * requests before the handler runs. The guard does not put the user ID on the
 * request, so this re-reads it and fails loudly rather than handing a `null`
 * down to a database foreign key.
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request>();
    const { userId } = getAuth(request);

    if (!userId) throw new UnauthorizedException();

    return userId;
  },
);
