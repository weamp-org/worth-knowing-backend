import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * How many rows the most-saved rail shows when the client does not say.
 *
 * Six rather than a round ten: it is a rail under the feed on a `max-w-3xl`
 * column, and a row taller than three lines is a `why` that got cut off rather
 * than a recommendation anybody can act on. The client's own default should not
 * be a guess about layout, though — it sends `?limit=` if it wants a different
 * number, and this is only what happens when nobody has an opinion.
 */
export const DEFAULT_TOP_SAVED = 6;

/**
 * Ceiling for the most-saved rail, well under {@link MAX_PAGE_SIZE}.
 *
 * The gap is the point. `MAX_PAGE_SIZE` exists to stop one request reading the
 * whole table through a keyset cursor, and this endpoint has no cursor — so the
 * bound here is not that safety property, it is the cost of the ordering.
 *
 * `mostSavedOrderBy` sorts by a relation count, which Postgres computes with a
 * join or an aggregate over `SavedResource` rather than from an index on
 * `Resource`. Asking for 100 of those is a genuinely different query from asking
 * for 6, and nothing on this route legitimately needs 100: the rail is a
 * homepage section, and a caller that wants the site's resources ordered by
 * popularity is asking for a ranking the API deliberately does not offer.
 */
export const MAX_TOP_SAVED = 24;

/**
 * The one parameter `GET /resources/top-saved` accepts.
 *
 * **Not `PaginationQueryDto`.** That class carries a `cursor`, and a cursor here
 * would be meaningless at best — the response is a bare array with no
 * `nextCursor` to hand back — and actively misleading at worst, because a
 * `ResourceSort` value pages with a bare id while this ordering cannot page at
 * all. A `?cursor=` that validated and was then ignored is the exact failure
 * `PaginationQueryDto`'s own doc comment warns about when it refuses to be shared
 * with the moderation queue.
 *
 * So the bound is restated rather than inherited, and the global `ValidationPipe`
 * running with `forbidNonWhitelisted` turns `?cursor=` into a 400 instead of a
 * silently dropped parameter.
 */
export class TopSavedQueryDto {
  /** How many rows to return.
   * @example 6
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_TOP_SAVED)
  limit?: number;
}
