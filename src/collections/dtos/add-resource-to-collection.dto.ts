import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Upper bound on a resource id, which is a cuid. Generous, to survive a change. */
const RESOURCE_ID_MAX_LENGTH = 64;

export class AddResourceToCollectionDto {
  /** The resource to add. Any resource on the site, not only the caller's own
   * @example 'ckq8f2a1b0000abcdefghijkl'
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(RESOURCE_ID_MAX_LENGTH)
  resourceId: string;
}
