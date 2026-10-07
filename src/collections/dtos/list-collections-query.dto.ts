import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  USERNAME_MAX_LENGTH,
  normalizeUsername,
} from '../../users/username.util';

/**
 * Page size when the client does not ask for one. Same default as the resource
 * feed — a collection's contents page is a resource listing, and a person
 * expecting one scrollful of content should not have to ask for it.
 */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard ceiling on `limit`, so one request cannot ask for the whole collection. */
export const MAX_PAGE_SIZE = 100;

export class ListMyCollectionsQueryDto {
  /**
   * Report, per collection, whether it already holds this resource.
   *
   * Only present because the "add to collection" picker needs to render saved
   * state, and asking for that one boolean for every collection at once is the
   * difference between one request and one per collection. Omit it and the field
   * is `false` throughout — see `CollectionSummaryDto.containsResource`.
   * @example 'ckq8f2a1b0000abcdefghijkl'
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceId?: string;

  /** How many collections to return.
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

/** `GET /api/v1/collections/:id/resources`. Separate from the above. */
export class ListCollectionResourcesQueryDto {
  /** How many resources to return.
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

/**
 * `GET /api/v1/collections` — public collections, newest first.
 *
 * `owner` is a username rather than a Clerk id for the reason `?contributor=` is:
 * this is a public parameter on a `@Public()` route, and the id is the primary
 * key of every account on the site, so filtering by it would be an enumeration
 * surface.
 */
export class ListPublicCollectionsQueryDto {
  /**
   * Restrict to one owner's public collections, by their username.
   *
   * The normalized form, as it appears in `ProfileResponseDto.usernameLower`, so
   * a profile page can pass through what it already has without re-folding it.
   *
   * An unknown username is an empty page, not a 404 — same as `?contributor=`, and
   * for the same reason: a profile is reachable by URL before anybody has claimed
   * the handle.
   * @example 'adal'
   */
  @IsOptional()
  @IsString()
  @MaxLength(USERNAME_MAX_LENGTH)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'owner must be a username, as shown on a profile',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeUsername(value).usernameLower : value,
  )
  owner?: string;

  /** How many collections to return.
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
