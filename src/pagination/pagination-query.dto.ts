import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Page size when the client does not ask for one. */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard ceiling on `limit`, so one request cannot ask for the whole table. */
export const MAX_PAGE_SIZE = 100;

/**
 * The two parameters every keyset-paginated list accepts, and nothing else.
 *
 * Split out of the per-feature list DTOs because those grew filters, and one of
 * them grew a filter that must **not** appear somewhere it is meaningless:
 * `ListResourcesQueryDto` backs both `GET /resources` and the `/resource-reports`
 * moderation queue, which needs a page size and a cursor and has no use for a
 * text search. Because the global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, sharing the class would have made `?q=` on the queue
 * validate cleanly and then be silently ignored — an admin filtering a
 * moderation queue by search term and quietly getting the unfiltered answer.
 *
 * The other list DTOs (`list-saved`, `list-collections`, `list-comments`) still
 * carry their own copies of these two properties and of the constants below.
 * That duplication predates this and is deliberately left alone; collapsing it is
 * a mechanical refactor of five files that has nothing to do with search, and
 * doing it here would bury the change that matters inside a rename.
 */
export class PaginationQueryDto {
  /** How many rows to return.
   * @example 20
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  /** Opaque cursor from a previous response's `nextCursor`. Omit for the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
