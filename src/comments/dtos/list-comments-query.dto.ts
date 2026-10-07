import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Page size when the client does not ask for one.
 *
 * The same default and ceiling as every other listing in the API. Deliberately not
 * raised for comments: a thread that runs to hundreds is the case where newest-first
 * ordering stops being a useful default anyway, and a bigger page is not the answer
 * to it.
 */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard ceiling on `limit`, so one request cannot ask for the whole thread. */
export const MAX_PAGE_SIZE = 100;

export class ListCommentsQueryDto {
  /** How many comments to return.
   * @example 20
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  /**
   * Opaque cursor from a previous response's `nextCursor`. Omit for the first page.
   *
   * Carries a single comment id. `resourceId` is already in the path and `id` is the
   * primary key, so unlike `SavedResource` there is no composite to reconstruct.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
