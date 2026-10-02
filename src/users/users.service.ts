import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ReservedUsernameReason } from '../generated/prisma/enums';

import { PrismaService } from '../prisma/prisma.service';
import { UpdateMyProfileDto } from './dtos/update-my-profile.dto';
import { UpdateMySettingsDto } from './dtos/update-my-settings.dto';
import {
  isUnsupportedScript,
  isValidUsername,
  normalizeUsername,
} from './username.util';
import { resolveDisplayName } from './display-name.util';

/** The subset of a user that is not their Clerk identity. */
const settingsSelect = { anonymousByDefault: true } as const;

/**
 * Everything a profile response is allowed to contain.
 *
 * A fixed `select` rather than a list of fields to strip out. Adding a column to
 * the `User` model — an email, a phone number, an internal flag — cannot leak
 * through this by accident; the query has to name it, in one place, on purpose.
 */
const profileSelect = {
  // Read for the owner check in `findByUsername` and the contribution count,
  // then dropped before the row leaves the service. See `withoutIdentity`.
  id: true,
  username: true,
  usernameLower: true,
  name: true,
  imageUrl: true,
  bio: true,
  createdAt: true,
  isProfilePrivate: true,
} as const;

/** A profile row as read, including the id used for owner checks. */
type ProfileRow = Prisma.UserGetPayload<{ select: typeof profileSelect }>;

/**
 * A profile as it leaves the service, with the id removed.
 *
 * The Clerk user id is read in two places — the owner check in
 * `findByUsername` and the contribution count — and is deliberately not part of
 * the response. `ContributorSummaryDto` does expose an id on a resource, but that
 * is a different contract: a profile is looked up by a public handle, and
 * publishing the primary key next to it invites it being used as an identifier
 * for something the profile itself does not expose.
 *
 * Written as a literal rather than `Omit<ProfileRow, 'id'>` so that a field
 * added to `profileSelect` does not silently become part of the response — which
 * is the same reason the query uses a fixed `select`.
 */
export type ProfileResponse = {
  username: string | null;
  usernameLower: string | null;
  /**
   * The Clerk name, falling back to the handle they claimed here.
   *
   * Null only for an account with neither, which means no contributions — the
   * `/share` gate guarantees a handle for anybody who can appear in a byline.
   */
  name: string | null;
  imageUrl: string | null;
  bio: string | null;
  createdAt: Date;
  isProfilePrivate: boolean;
  resourcesCount: number;
  isOwner: boolean;
};

/** Drops the id and attaches the count, in one place every read goes through. */
function toProfileResponse(
  user: ProfileRow,
  resourcesCount: number,
  isOwner: boolean,
): ProfileResponse {
  const rest: ProfileResponse = {
    username: user.username,
    usernameLower: user.usernameLower,
    // Resolved here rather than stored: a user with no Clerk name falls back to
    // the handle they claimed, and nobody is ever called "Anonymous".
    name: resolveDisplayName(user),
    imageUrl: user.imageUrl,
    bio: user.bio,
    createdAt: user.createdAt,
    isProfilePrivate: user.isProfilePrivate,
    resourcesCount,
    isOwner,
  };

  return rest;
}

/** P2002: a unique index rejected the write. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * The caller's own settings.
 *
 * Returns just the preferences rather than the whole record: a settings
 * endpoint has no reason to hand back an email address it did not ask for.
 */
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

  /**
   * A profile as its owner sees it.
   *
   * Same shape as the public read **plus `role`**, and the `plus role` is
   * load-bearing.
   *
   * A private profile has to render on its owner's screen without the page needing
   * to know it is private, which rules out a redacted variant — so the own-profile
   * read cannot be a subset of the public one. `resourcesCount` is included so the
   * profile page needs one request rather than two.
   *
   * `role` is here and nowhere else. `ProfileResponseDto` withholds it — the whole
   * point of that fixed allowlist is that an identity field cannot leak by being
   * added to the model later — and that objection stands fully against the *public*
   * read: whether somebody is an admin is nobody else's business on their profile.
   *
   * It is not a leak here. This is your own role, returned to you, and there are now
   * two callers that need it: the header offers a moderation link only to admins,
   * and `/moderation` has to tell "sign in" apart from "not allowed" before it
   * renders either. Neither was possible while the only way to learn a role was to
   * ask a route that refuses you.
   *
   * Selected by spreading the public select rather than by adding `role` to
   * `profileSelect`, which would publish it on every profile on the site.
   */
  async findMyProfile(id: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: { ...profileSelect, role: true },
    });

    return {
      ...(await this.withResourceCount(user, id)),
      role: user.role,
    };
  }

  /**
   * A profile as somebody else sees it.
   *
   * A private profile is a **404, not a 403**. A 403 would confirm the username
   * exists, which is the one fact the contributor asked to withhold — the
   * response would leak by its own shape. 404 is indistinguishable from a
   * username nobody has ever claimed, which is the intended reading.
   *
   * Admins are not let through. A moderation surface is a separate product with
   * its own design, and this route is a public profile page; a caller who needs
   * to see a private profile is a caller who needs that surface to exist first.
   */
  async findByUsername(
    username: string,
    viewerId?: string,
  ): Promise<ProfileResponse> {
    const usernameLower = normalizeUsername(username).usernameLower;
    const user = await this.prisma.user.findUnique({
      where: { usernameLower },
      select: profileSelect,
    });

    // The owner sees their own private profile, checked before the privacy test
    // so a private profile is still editable and still renders for them.
    if (!user || (user.isProfilePrivate && user.id !== viewerId)) {
      throw new NotFoundException(`No profile at /u/${usernameLower}`);
    }

    return this.withResourceCount(user, viewerId);
  }

  /**
   * Updates the caller's own profile.
   *
   * The id comes from the session, never the body, so there is no route by which
   * one account can edit another's profile.
   *
   * A username is resolved, validated and claimed before anything is written, so
   * a rejected handle never leaves a half-applied bio behind. The one exception
   * is the transaction below, which is what makes the claim itself atomic.
   */
  async updateMyProfile(id: string, dto: UpdateMyProfileDto) {
    // A claimed handle and a held-handle release are one unit of work. Running
    // the username on its own first would let a bio save against a claim that
    // then failed, leaving the caller unsure what state they are in.
    if (dto.username !== undefined) {
      const claimed = await this.resolveClaim(id, dto.username);
      const user = await this.applyClaim(id, claimed);

      // The remaining fields, if any, are a second write. Both have passed their
      // own validation by now, so this cannot fail for a reason that would
      // unwind the claim.
      return this.withResourceCount(
        await this.applyProfileFields(id, dto, user),
        id,
      );
    }

    return this.withResourceCount(await this.applyProfileFields(id, dto), id);
  }

  /**
   * Writes the non-username profile fields, if the DTO carries any.
   *
   * Only fields the DTO actually carries. Spreading `undefined` would send an
   * explicit null to a non-nullable column, and `bio` is the one nullable field
   * here where a missing key and an explicit null mean different things.
   */
  private async applyProfileFields(
    id: string,
    dto: UpdateMyProfileDto,
    claimed?: ProfileRow,
  ): Promise<ProfileRow> {
    const data: Prisma.UserUpdateInput = {};

    if (dto.bio !== undefined) data.bio = dto.bio;

    if (dto.isProfilePrivate !== undefined) {
      data.isProfilePrivate = dto.isProfilePrivate;
    }

    // A username-only patch has already been written by `applyClaim`. Returning
    // it avoids a pointless second UPDATE that would set nothing.
    if (Object.keys(data).length === 0 && claimed) return claimed;

    return this.prisma.user.update({
      where: { id },
      data,
      select: profileSelect,
    });
  }

  /**
   * Turns a typed username into a pair that is safe to store, or throws.
   *
   * Order matters here, because each check answers a different question and the
   * person typing gets a different message for each:
   *
   * 1. Is it a script we cannot spell yet? That is a gap we have promised to
   *    close, so it is not reported as "invalid characters".
   * 2. Is it a shape we would issue at all? Length and charset.
   * 3. Is it free? Only a query can answer this, and it is the only check that
   *    can be wrong by racing.
   */
  private async resolveClaim(
    userId: string,
    typed: string,
  ): Promise<{ username: string; usernameLower: string }> {
    if (isUnsupportedScript(typed)) {
      throw new BadRequestException(
        'Usernames in that script are not supported yet. Letters and numbers from the Latin alphabet, and underscores, are what we can use right now.',
      );
    }

    const { username, usernameLower } = normalizeUsername(typed);

    if (!isValidUsername(usernameLower)) {
      throw new BadRequestException(
        'A username must be 3 to 24 characters, using lowercase letters, numbers and underscores, and start with a letter.',
      );
    }

    // A reserved word can never be claimed, so it is checked before the
    // availability read rather than after — otherwise a reserved username would
    // read as "taken" and invite a retry that will also fail.
    const reserved = await this.prisma.reservedUsername.findUnique({
      where: { usernameLower },
      select: { reason: true },
    });

    if (reserved) {
      throw new ConflictException(
        reserved.reason === ReservedUsernameReason.RESERVED
          ? 'That username is reserved. Try another one.'
          : 'That username was claimed by someone else before and cannot be claimed again. Try another one.',
      );
    }

    // Somebody else holding it right now.
    const holder = await this.prisma.user.findUnique({
      where: { usernameLower },
      select: { id: true },
    });

    if (holder && holder.id !== userId) {
      throw new ConflictException('That username is already taken.');
    }

    return { username, usernameLower };
  }

  /**
   * Claims the handle, holding whatever the caller had before.
   *
   * The username column's unique index is not the only guard here, and cannot
   * be: it would stop two people claiming the same handle, but not a handle
   * being claimed a second time by its own previous holder after being
   * released. `ReservedUsername` is the record of what has ever been issued, and
   * it is what the check in {@link resolveClaim} reads.
   *
   * All three steps go in one transaction. A username change that dropped the
   * old handle outside the transaction that granted the new one would leave a
   * window where the old handle is claimable by anybody — which is the exact
   * handle-squatting this table exists to prevent. The *read* of the previous
   * handle is inside for the same reason: read outside, it can go stale against
   * a concurrent change and the handle actually held would never be recorded.
   */
  private async applyClaim(
    userId: string,
    claimed: { username: string; usernameLower: string },
  ): Promise<ProfileRow> {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { usernameLower: true },
      });

      // Re-asserting the handle you already hold is not a change. Releasing it
      // into `ReservedUsername` here would make your own username permanently
      // unclaimable by you the moment you saved an unrelated bio.
      if (
        previous.usernameLower &&
        previous.usernameLower !== claimed.usernameLower
      ) {
        await tx.reservedUsername.upsert({
          where: { usernameLower: previous.usernameLower },
          update: {},
          create: {
            usernameLower: previous.usernameLower,
            reason: ReservedUsernameReason.RELEASED,
          },
        });
      }

      try {
        return await tx.user.update({
          where: { id: userId },
          data: {
            username: claimed.username,
            usernameLower: claimed.usernameLower,
          },
          select: profileSelect,
        });
      } catch (error) {
        // Two claims that both passed the availability read above. The index is
        // what actually decides, so a loser has to come out as the same 409 a
        // deliberate collision gets rather than as a 500.
        if (isUniqueViolation(error)) {
          throw new ConflictException('That username is already taken.');
        }

        throw error;
      }
    });
  }

  /**
   * Attaches a contribution count to a profile row.
   *
   * Anonymous contributions are excluded. Counting them would disclose that they
   * exist — the profile would report a number only its owner can reconcile
   * against their own contributions, which is a smaller leak than it sounds and
   * a completely pointless one to take.
   */
  private async withResourceCount(
    user: ProfileRow,
    viewerId?: string,
  ): Promise<ProfileResponse> {
    const resourcesCount = await this.prisma.resource.count({
      where: { contributorId: user.id, isAnonymous: false },
    });

    return toProfileResponse(user, resourcesCount, user.id === viewerId);
  }
}
