import { OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { CreateUserDto } from './create-user.dto';

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['id'] as const),
) {}

/**
 * The caller's own settings.
 *
 * Deliberately separate from {@link UpdateUserDto} and addressed at `/users/me`
 * rather than by id. A body carrying an id is a body that can name somebody
 * else, and an anonymity preference is not something a route should be able to
 * set on someone else's behalf.
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
