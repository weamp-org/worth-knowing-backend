import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Upper bound on a collection title. Matches the column. */
export const COLLECTION_TITLE_MAX_LENGTH = 120;

/** Upper bound on a collection description. Matches the column. */
export const COLLECTION_DESCRIPTION_MAX_LENGTH = 500;

export class CreateCollectionDto {
  /** A short, human-readable name for the collection
   * @example 'Read before starting research'
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(COLLECTION_TITLE_MAX_LENGTH)
  title: string;

  /** Why these resources belong together, in the owner's own words
   * @example 'The four papers that made agent-based modelling click for me.'
   */
  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_DESCRIPTION_MAX_LENGTH)
  description?: string;

  /** Whether anyone but the owner can open the collection. Omit and it defaults to private.
   * @example true
   */
  @IsOptional()
  @IsBoolean()
  // Without this, the global `enableImplicitConversion` turns the string "false"
  // into `true` — because `Boolean("false")` is `true`.
  @Type(() => Object)
  isPrivate?: boolean;
}
