import { BadRequestException } from '@nestjs/common';

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
 * for us, so the ordering tuple (`createdAt DESC, id DESC`) stays in one place —
 * the query — rather than being split between an encoded timestamp here and the
 * database. Base64 is only for opacity, so a client cannot read ids out of it or
 * hand-craft a cursor for a row it has not seen.
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
 * Prisma's problem, and {@link ResourcesService.findAll} turns its "cursor not
 * found" into a 400.
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
