import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

import { AccessType, ResourceType } from '../../generated/prisma/enums';

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

  /** Whether the resource is free, paid, or freemium. Defaults to UNKNOWN
   * when the contributor is not sure.
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
}
