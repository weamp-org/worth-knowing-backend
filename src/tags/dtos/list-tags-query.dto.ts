import { IsOptional, IsString, MaxLength } from 'class-validator';

import { TAG_SLUG_MAX_LENGTH } from '../slugify.util';

export class ListTagsQueryDto {
  /** Free-text search. Omit it to get the most-used tags.
   * @example 'machine'
   */
  @IsOptional()
  @IsString()
  @MaxLength(TAG_SLUG_MAX_LENGTH)
  query?: string;
}
