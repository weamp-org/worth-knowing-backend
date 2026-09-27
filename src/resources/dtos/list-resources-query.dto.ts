import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { TAG_SLUG_MAX_LENGTH } from '../../tags/slugify.util';

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
}
