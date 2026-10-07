import { Type } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * The caller's own settings.
 *
 * Deliberately its own DTO, addressed at `/users/me/settings` rather than by
 * id. The template's `PATCH /users/:id` accepted `name` and `email`, but both
 * are owned by Clerk and overwritten on every Clerk webhook, so a local write
 * would silently revert. Removing that route left nothing for
 * `UpdateUserDto` to describe, and this is the only user-writable field that
 * exists.
 *
 * There is no id in the body at all: the route takes it from the session, so
 * there is nothing here that could name somebody else.
 */
export class UpdateMySettingsDto {
  /** Whether contributions are shared anonymously unless overridden.
   * @example true
   */
  @IsOptional()
  @IsBoolean()
  // See the same note in `CreateResourceDto`: `enableImplicitConversion` would
  // turn the string "false" into `true`.
  @Type(() => Object)
  anonymousByDefault?: boolean;
}
