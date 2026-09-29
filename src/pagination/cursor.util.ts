import { BadRequestException } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client';

/** Generous bound: a cuid is 25 characters, so anything longer is not one. */
const MAX_CURSOR_LENGTH = 64;

/**
 * Characters an id may contain. Deliberately broader than cuid's own alphabet so
 * a change of id generator does not silently break cursors, but narrow enough to
 * exclude whitespace, control characters, quotes and separators.
 */
const IMPLAUSIBLE_ID = /[^\w.:+@-]/;

/**
 * Opaque keyset cursor.
 *
 * Encodes the id of the last row on a page. Prisma resolves the row's position
 * for us, so the ordering tuple stays in one place — the query — rather than
 * being split between an encoded timestamp here and the database. Base64 is only
 * for opacity, so a client cannot read ids out of it or hand-craft a cursor for a
 * row it has not seen.
 *
 * Shared rather than kept per feature. Both call sites encode a single id, but
 * they encode it from *different* rows: a resource feed pages over `Resource`,
 * a collection's contents page over `CollectionResource`, whose id is the
 * `resourceId` it holds. A second copy of these bounds and this character class
 * would be free to drift from the first, and a cursor decoder that has quietly
 * loosened its validation is the kind of bug that only shows up in production.
 */
export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, rejecting anything that is not one we could have issued.
 *
 * This deliberately does **not** pin the id format to cuid's own alphabet — that
 * is a guess that silently rejects valid ids if the generator ever changes, and
 * Prisma parameterises the query, so there is no injection surface to guard
 * against. The allowlist below is a loose superset of any plausible id, and only
 * rejects input that cannot be one. Anything allowed through but unknown is
 * Prisma's problem, and the caller turns its "cursor not found" into a 400.
 *
 * @throws BadRequestException when the cursor is not base64url, is empty, or
 * decodes to something that cannot be an id
 */
export function decodeCursor(cursor: string): string {
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new BadRequestException('Invalid cursor');
  }

  let decoded: string;

  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestException('Invalid cursor');
  }

  if (decoded.length === 0 || decoded.length > MAX_CURSOR_LENGTH) {
    throw new BadRequestException('Invalid cursor');
  }

  if (IMPLAUSIBLE_ID.test(decoded)) {
    throw new BadRequestException('Invalid cursor');
  }

  return decoded;
}

/**
 * Whether a Prisma failure is a bad cursor rather than a real fault.
 *
 * In practice Prisma 7 returns an empty page for a cursor whose row is gone,
 * which is the behaviour we want: a resource can be deleted between a client
 * reading a page and requesting the next, and a 400 there would be a spurious
 * error. This is a guard for the paths that do raise — P2025 for a missing
 * cursor row, P2023 for inconsistent column data — so they surface as a client
 * error rather than a 500 leaking driver text.
 *
 * Shared with {@link CollectionsService} for the same reason the encoder is: the
 * Prisma error codes are not a per-feature detail, and a second list of them
 * would eventually be a shorter one.
 */
export function isCursorNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2025' || error.code === 'P2023')
  );
}
