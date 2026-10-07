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

/** Hard ceiling on `limit`, so one request cannot ask for the whole list. */
export const MAX_PAGE_SIZE = 100;

export class ListSavedQueryDto {
  /** How many saved resources to return.
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
