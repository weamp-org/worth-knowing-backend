import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UpdateMySettingsDto } from './dtos/update-my-settings.dto';

/** The subset of a user that is not their Clerk identity. */
const settingsSelect = { anonymousByDefault: true } as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's own settings.
   *
   * Returns just the preferences rather than the whole record: a settings
   * endpoint has no reason to hand back an email address it did not ask for.
   */
  async findMySettings(id: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: settingsSelect,
    });
  }

  /**
   * Updates the caller's own settings.
   *
   * The id is the Clerk user id and comes from the session, never the body, so
   * there is no route by which one account can set another's preference.
   */
  async updateMySettings(id: string, dto: UpdateMySettingsDto) {
    // Only fields the DTO actually carries. Spreading `undefined` would
    // otherwise send an explicit null to a non-nullable column.
    const data: { anonymousByDefault?: boolean } = {};

    if (dto.anonymousByDefault !== undefined) {
      data.anonymousByDefault = dto.anonymousByDefault;
    }

    return this.prisma.user.update({
      where: { id },
      data,
      select: settingsSelect,
    });
  }
}
