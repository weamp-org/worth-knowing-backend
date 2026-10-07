import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { TAG_SLUG_MAX_LENGTH } from '../slugify.util';

/** Upper bound on `limit`, so one request cannot ask for the whole table. */
export const MAX_TAG_LIST_LIMIT = 1000;

export class ListTagsQueryDto {
  /** Free-text search. Omit it to get the most-used tags.
   * @example 'machine'
   */
  @IsOptional()
  @IsString()
  @MaxLength(TAG_SLUG_MAX_LENGTH)
  query?: string;

  /**
   * How many tags to return.
   *
   * **Omitting it keeps the navigation behaviour exactly as it has always been** —
   * a deliberate cut at the most-used twenty. The tag nav on the home page and on
   * `/browse` is a most-used cut and always has been, which is why the count sits
   * beside each chip: it is what makes the cut legible rather than arbitrary.
   *
   * Asking for more is for callers that genuinely want the whole vocabulary — the
   * sitemap, which needs every tag that is actually attached to something. It is
   * not a way to make the nav chips longer, and a larger nav would be a worse
   * surface rather than a fuller one.
   * @example 500
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_TAG_LIST_LIMIT)
  limit?: number;
}
