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
