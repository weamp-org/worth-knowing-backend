import { UserRole } from '../../generated/prisma/enums';

export class UserResponseDto {
  /** The Clerk user ID
   * @example 'user_2abc'
   */
  id: string;

  name: string;

  email: string;

  imageUrl: string | null;

  role: UserRole;

  anonymousByDefault: boolean;
}

/**
 * The caller's own preferences.
 *
 * Deliberately not the whole {@link UserResponseDto}: a settings endpoint has
 * no reason to hand back an email address, a role, or a name it did not ask
 * for.
 */
export class MySettingsDto {
  /** Whether contributions are shared anonymously unless overridden.
   * @example true
   */
  anonymousByDefault: boolean;
}
