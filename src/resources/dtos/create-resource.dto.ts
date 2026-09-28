import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

import { AccessType, ResourceType } from '../../generated/prisma/enums';
import { MAX_TAGS_PER_RESOURCE } from '../../tags/tags.service';
import { TAG_SLUG_MAX_LENGTH } from '../../tags/slugify.util';

export class CreateResourceDto {
  /** A short, human-readable name for the resource
   * @example 'Sapiens: A Brief History of Humankind'
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  /** A direct link to the specific resource being shared
   * @example 'https://www.goodreads.com/book/show/33710.Sapiens'
   */
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: true,
  })
  @MaxLength(2048)
  url: string;

  /** What kind of resource this is
   * @example 'BOOK'
   */
  @IsEnum(ResourceType)
  type: ResourceType;

  /** Whether the resource is free, paid, or freemium. Omit when unsure and it defaults to UNKNOWN.
   * @example 'FREE'
   */
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;

  /** Why the contributor thinks this resource is worth knowing
   * @example 'The clearest explanation of how human institutions co-evolved that I have read.'
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  why: string;

  /** Free-form tags, created on the fly if they do not exist yet
   * @example ['Machine Learning', 'evolution']
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS_PER_RESOURCE)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(TAG_SLUG_MAX_LENGTH, { each: true })
  tags?: string[];

  /** Withhold the contributor from public responses. Omit to fall back to the
   * contributor's standing preference from their settings.
   * @example true
   */
  @IsOptional()
  @IsBoolean()
  // Without this, the global `enableImplicitConversion` turns the string
  // "false" into `true` — because `Boolean("false")` is `true` — so a client
  // sending a string would get the exact opposite of what it asked for. That
  // inversion is unacceptable on a privacy flag. Widening the type stops
  // class-transformer coercing, and `@IsBoolean` then rejects the string.
  @Type(() => Object)
  isAnonymous?: boolean;
}
