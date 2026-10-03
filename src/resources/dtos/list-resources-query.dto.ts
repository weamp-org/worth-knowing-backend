import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../pagination/pagination-query.dto';
import { TAG_SLUG_MAX_LENGTH } from '../../tags/slugify.util';
import {
  USERNAME_MAX_LENGTH,
  normalizeUsername,
} from '../../users/username.util';
import { AccessType, ResourceType } from '../../generated/prisma/enums';
import { ResourceSort } from '../resource-read';

/**
 * Longest `q` accepted.
 *
 * Not derived from any column: `title` is 200 characters and `why` is 5000, so a
 * bound taken from either would admit a needle that is not a search anybody typed.
 * A trigram comparison also gets slower as the needle grows — `word_similarity`
 * scores the query against every trigram window of the haystack, so cost grows with
 * the product of the two lengths — which makes an unbounded `q` a cheap way to make
 * an expensive query. 100 characters is far beyond any real search term.
 */
export const SEARCH_QUERY_MAX_LENGTH = 100;

export class ListResourcesQueryDto extends PaginationQueryDto {
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

  /**
   * Free-text search over titles, tags and `why`, best match first.
   *
   * Trimmed here so that a service or a test calling this path directly gets the
   * same value a controller would. An empty result is **not** a search — see
   * {@link ResourcesService.findAll}, which treats a blank `q` as absent and
   * returns the ordinary feed, so `?q=` behaves like `/` rather than like a
   * search for nothing.
   *
   * The response shape and the cursor are otherwise identical to an unfiltered
   * list, but the cursor means something different: relevance order is not
   * `(createdAt, id)`, so it carries a score alongside the id. A cursor from an
   * unfiltered page is not valid here and vice versa.
   * @example 'machine learning'
   */
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_QUERY_MAX_LENGTH)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  q?: string;

  /**
   * Restrict to one kind of resource.
   *
   * Validated against the schema's own enum rather than a regex, so a type that
   * is added to `schema.prisma` is accepted here without touching this file and
   * one that is removed stops being accepted instead of silently matching nothing.
   *
   * Single value only. `?type=BOOK&type=COURSE` is a reasonable next step and is
   * additive when wanted — an array with a cap — but it is not built now, and
   * saying so is cheaper than shipping a half-formed version of it.
   * @example 'BOOK'
   */
  @IsOptional()
  @IsEnum(ResourceType)
  type?: ResourceType;

  /**
   * Restrict to one access level.
   *
   * `UNKNOWN` is the schema default, which means a resource nobody has classified
   * is genuinely `UNKNOWN` rather than absent — so a browse page filtering on
   * `FREE` will not silently include unclassified resources. That is the honest
   * behaviour, and the alternative (treating `UNKNOWN` as a wildcard) would make
   * the filter lie about what it matched.
   * @example 'FREE'
   */
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;

  /**
   * Ordering. Omit it for newest first — or for relevance, if `q` is present.
   *
   * See {@link ResourceSort} for the values and for why relevance is the absence
   * of this parameter rather than one of them.
   *
   * Note that `?q=` with a `sort` set is meaningful and not contradictory: it
   * means "everything that matched, in this order" rather than "best matches
   * first". Both are worth having, and both fall out of leaving relevance as the
   * no-`sort` case.
   * @example 'title'
   */
  @IsOptional()
  @IsEnum(ResourceSort)
  sort?: ResourceSort;
}
