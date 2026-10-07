import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { TAG_SLUG_MAX_LENGTH } from '../slugify.util';

/**
 * The only thing an admin may change about a tag.
 *
 * There is no `slug`, and that omission is the point: the slug is the tag's
 * identity and it appears in feed URLs that other people have linked. A rename
 * that touched it would break those links with no redirect to absorb them. The
 * service re-validates this through the same `normalizeTags` path a
 * contributor's tag takes, so the bound here is a fast reject rather than the
 * only check.
 */
export class UpdateTagDto {
  /** The new display form, as it should read to a person.
   * @example 'Machine Learning'
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(TAG_SLUG_MAX_LENGTH)
  name: string;
}
