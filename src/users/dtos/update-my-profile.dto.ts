import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '../username.util';
import { BIO_MAX_LENGTH } from './profile-response.dto';

/**
 * The caller's own profile: the fields this application owns.
 *
 * Not an extension of `UpdateMySettingsDto`, and the split is deliberate.
 * Settings are boolean preferences about how to behave; a profile is an identity
 * — a handle that appears in a URL, on a page, and on somebody's byline. The two
 * have different validation, different failure modes and different blast radii:
 * a rejected username is a 409 somebody retries, a failed bio is a field that did
 * not save. Mixing them would also mean the settings response started carrying
 * public identity, which is what it was written to avoid.
 *
 * `name` and `imageUrl` are absent, and cannot be added: both are owned by Clerk
 * and rewritten on every Clerk webhook, so a local write here would silently
 * revert. Those are edited through Clerk's own profile UI.
 */
export class UpdateMyProfileDto {
  /**
   * The handle to claim, as typed. Case is preserved for display; availability is
   * checked against the normalized form.
   *
   * Omit to leave the current username alone — this is a partial update, so
   * patching only a bio does not clear a claimed handle.
   * @example 'AdaL'
   */
  @IsOptional()
  @IsString()
  @MinLength(USERNAME_MIN_LENGTH, {
    message: `username must be at least ${USERNAME_MIN_LENGTH} characters`,
  })
  @MaxLength(USERNAME_MAX_LENGTH, {
    message: `username must be at most ${USERNAME_MAX_LENGTH} characters`,
  })
  // The character allowlist is deliberately absent. It is applied to the
  // *normalized* form in the service, because `class-validator` sees the raw
  // string and accented Latin only folds to ASCII there: a pattern on this
  // decorator would reject `Café` for a reason that is not the user's fault, and
  // would reject uppercase that the service is about to lowercase anyway.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  username?: string;

  /**
   * A line or two about the person. Null clears it; an empty string is rejected
   * as empty rather than silently treated as a clear, so a stray keystroke cannot
   * wipe a bio the contributor spent a minute writing.
   * @example 'Compiler notes and difference engines.'
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(BIO_MAX_LENGTH, {
    message: `bio must be at most ${BIO_MAX_LENGTH} characters`,
  })
  bio?: string;

  /**
   * Whether the profile page resolves for anyone but its owner.
   *
   * Lives here rather than in settings because it is a statement about this
   * profile. It never changes attribution on anything already shared.
   * @example true
   */
  @IsOptional()
  @IsBoolean()
  // Same reason as `CreateResourceDto.isAnonymous`: the global
  // `enableImplicitConversion` would turn the string "false" into `true`,
  // inverting a privacy flag. Widening the type stops class-transformer
  // coercing, and `@IsBoolean` then rejects the string outright.
  @Type(() => Object)
  isProfilePrivate?: boolean;
}
