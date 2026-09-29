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

import { TAG_SLUG_MAX_LENGTH } from '../../tags/slugify.util';
import {
  USERNAME_MAX_LENGTH,
  normalizeUsername,
} from '../../users/username.util';

/** Page size when the client does not ask for one. */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard ceiling on `limit`, so one request cannot ask for the whole table. */
export const MAX_PAGE_SIZE = 100;

export class ListResourcesQueryDto {
  /** Filter to a single tag, by slug as returned from `GET /api/v1/tags`.
   * @example 'machine-learning'
   */
  @IsOptional()
  @IsString()
  @MaxLength(TAG_SLUG_MAX_LENGTH)
  @Matches(/^[a-z0-9.+#-]+$/, {
    message: 'tag must be a tag slug, as returned from GET /api/v1/tags',
  })
  tag?: string;

  /**
   * Restrict to one contributor's resources, by their username.
   *
   * The normalized form, as it appears in `ProfileResponseDto.usernameLower`, so
   * a profile page can pass through what it already has without re-folding it.
   * Case-insensitive input is accepted and folded, because a person typing
   * `?contributor=AdaL` into the address bar should not get an empty page.
   *
   * An unknown username is an empty page, not a 404. A profile's listing is
   * reachable by URL before anybody has claimed the handle, and the cursor
   * behaves the same way for a row deleted between pages.
   * @example 'adal'
   */
  @IsOptional()
  @IsString()
  @MaxLength(USERNAME_MAX_LENGTH)
  // Runs after the `@Transform` below, so this sees the folded form. Rejecting a
  // malformed value here is better than an empty page for it: `?contributor=ada
  // -lovelace` is a typo, and silently returning nothing reads as "this person
  // has shared nothing" rather than as "that is not a username".
  @Matches(/^[a-z0-9_]+$/, {
    message: 'contributor must be a username, as shown on a profile',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeUsername(value).usernameLower : value,
  )
  contributor?: string;

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
