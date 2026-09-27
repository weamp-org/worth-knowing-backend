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
}
