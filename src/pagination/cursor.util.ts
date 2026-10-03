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
 *
 * The two report queues read the same codes but treat a missing row as a client bug
 * rather than as a normal thing that happened — a comment or a resource only
 * disappears when somebody chooses to remove it. The predicate is identical either
 * way; what differs is the exception the caller wraps it in.
 */
export function isCursorNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2025' || error.code === 'P2023')
  );
}

/**
 * Decodes a report-queue cursor into a `(targetId, reporterId)` pair.
 *
 * Report queues page over a composite primary key — `(reporterId, commentId)` and
 * `(reporterId, resourceId)` — because that is what makes reporting idempotent.
 * Neither half is unique alone, so the opaque cursor has to carry both, which is the
 * one case here where a bare id is not enough.
 *
 * One base64url blob over `targetId:reporterId` — **target first**, unlike the primary
 * key's actor-first order — so the two queues encode identically and the callers can
 * name the halves for what they point at. Decoded once, which also applies
 * {@link decodeCursor}'s base64 and character checks; the split is on the **first**
 * colon.
 *
 * @throws BadRequestException when the cursor does not decode to two non-empty parts
 */
export function decodeReportCursor(cursor: string): {
  targetId: string;
  reporterId: string;
} {
  const decoded = decodeCursor(cursor);
  const separator = decoded.indexOf(':');

  // Both halves must be present. Defending past that is not worth it: a well-formed
  // cursor naming a row that does not exist resolves to an empty page, and Prisma
  // parameterises the lookup, so there is no injection surface either way. A colon is
  // inside `IMPLAUSIBLE_ID`'s allowlist, so a cursor carrying more than one is
  // possible and simply lands in the second half, where it matches nothing.
  if (separator <= 0 || separator === decoded.length - 1) {
    throw new BadRequestException('Invalid cursor');
  }

  return {
    targetId: decoded.slice(0, separator),
    reporterId: decoded.slice(separator + 1),
  };
}

/** Encodes a report-queue cursor. The inverse of {@link decodeReportCursor}. */
export function encodeReportCursor(
  targetId: string,
  reporterId: string,
): string {
  return encodeCursor(`${targetId}:${reporterId}`);
}

/**
 * Decodes a search cursor into the `(score, id)` pair it pages over.
 *
 * Search is the one ordering here that is **computed** rather than read off a
 * column, so a bare id is not enough — the same objection `docs/saved.md` raises
 * against sorting by saved count. The score has to travel with the id or the
 * database has no way to know where in the ranking to resume.
 *
 * `score:id`, in the same order as the `ORDER BY score DESC, id DESC` that produced
 * it, so the halves are named for what they point at. Encoded through
 * {@link decodeCursor}, which brings the base64 and character checks with it.
 *
 * The score is required to be a non-negative **integer**, which is a real
 * constraint rather than tidiness: `resources/resource-search.ts` scores in whole
 * bands, and rejecting a fractional score here means a cursor minted by an older
 * or newer scoring formula is refused outright instead of silently paging from the
 * wrong place.
 *
 * @throws BadRequestException when the cursor does not decode to a score and an id
 */
export function decodeRankedCursor(cursor: string): {
  score: number;
  id: string;
} {
  const decoded = decodeCursor(cursor);
  const separator = decoded.indexOf(':');

  // Same reasoning as the report cursor: both halves must be present, and nothing
  // past that point is worth defending. A ranked cursor that decodes but names a
  // row that no longer exists yields an empty page, which is the behaviour a
  // resource deleted mid-search should produce.
  if (separator <= 0 || separator === decoded.length - 1) {
    throw new BadRequestException('Invalid cursor');
  }

  const score = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isInteger(score) || score < 0) {
    throw new BadRequestException('Invalid cursor');
  }

  return { score, id };
}

/** Encodes a search cursor. The inverse of {@link decodeRankedCursor}. */
export function encodeRankedCursor(score: number, id: string): string {
  return encodeCursor(`${score}:${id}`);
}
