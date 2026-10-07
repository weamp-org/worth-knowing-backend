import { UserRole } from '../../generated/prisma/enums';

/**
 * A person's public profile, and — on `GET /users/me/profile` only — the caller's own
 * role.
 *
 * This is a reversal, and deliberately so. `UserResponseDto` was removed from
 * this codebase along with the CRUD routes that returned it, on the grounds that
 * it handed every signed-in caller a list of everyone's email addresses. That
 * objection stands against *that* DTO and is why none of these fields is one of
 * them:
 *
 * - No `email`, no `role`, and no Clerk user id. This response is assembled
 *   from a fixed `select`, so an identity field cannot leak by being added to
 *   the model later — it would have to be added here first, visibly.
 * - No `anonymousByDefault`. It is a standing preference, not a fact about
 *   somebody that belongs in public.
 *
 * What is left is the thing a profile page is actually made of: how to address
 * the person, how they look, what they say about themselves, and when they
 * arrived.
 *
 * ### `role` is the one exception, and only on `GET /users/me/profile`
 *
 * Every "no role" above is about *somebody else's* profile. Your own role, returned
 * to you, is not a disclosure: the header needs it to decide whether to offer a
 * moderation link, and `/moderation` needs it to tell "sign in" apart from "not
 * allowed" before rendering either. Neither was reachable while the only way to learn
 * a role was to ask a route that refuses you.
 *
 * It is `UserRole` on the own read and **nothing else** — not on the public read, not
 * in the docs above it, not on any other route. `ResourcesService.findMyProfile`
 * spreads the public `select` and adds this one field, rather than `profileSelect`
 * growing it, which would publish it on every profile on the site.
 */
export class ProfileResponseDto {
  /** The typed form, for display. Resolution and URLs use the lowercase form.
   * `null` for an account that has never claimed one.
   * @example 'AdaL'
   */
  username: string | null;

  /** The lowercase identity. Unique across all users, and what `/u/:username` matches.
   * `null` for an account that has never claimed one.
   * @example 'adal'
   */
  usernameLower: string | null;

  /**
   * Display name: the Clerk name, or failing that the handle claimed here.
   *
   * Never a placeholder. Null only for an account with neither, which means no
   * contributions — the `/share` gate guarantees a handle for anybody who can
   * appear in a byline.
   * @example 'Ada Lovelace'
   */
  name: string | null;

  /** Avatar, likewise owned by Clerk. Null until they set one.
   * @example 'https://img.clerk.com/ada.png'
   */
  imageUrl: string | null;

  /** Free text, written by the contributor. Null when unset.
   * @example 'Compiler notes and difference engines.'
   */
  bio: string | null;

  createdAt: Date;

  /**
   * Whether the owner has hidden this profile.
   *
   * Always false on a public read, since a private profile is a 404 to everyone
   * but its owner. Present so the owner's own profile page can render the same
   * component the public one does, rather than needing to know it is private.
   * @example false
   */
  isProfilePrivate: boolean;

  /**
   * How many of their contributions carry their name.
   *
   * Anonymous contributions are excluded, because counting them would disclose
   * the existence of posts the contributor chose to withhold — the profile would
   * report a number that only they can reconcile.
   * @example 12
   */
  resourcesCount: number;

  /**
   * Whether the caller is this profile's owner.
   *
   * Present because the response carries no identifier to compare against — the
   * Clerk user id is deliberately withheld — so a client has no way to work this
   * out itself. Decided on the server for the same reason `profilePath` is: a
   * client asked to infer ownership will infer it wrongly somewhere, and the
   * result is an edit link on somebody else's profile.
   *
   * Always true on `GET /users/me/profile`.
   * @example false
   */
  isOwner: boolean;

  /**
   * The caller's own role. **Present only on `GET /users/me/profile`.**
   *
   * Your own role, returned to you — not a disclosure, and the one exception to the
   * fixed allowlist above. The header uses it to decide whether to offer a moderation
   * link, and `/moderation` uses it to tell "sign in" apart from "not allowed"
   * instead of rendering a queue it then has to swap for an error.
   *
   * Always `USER` on a public read *by omission* — this field is not on the public
   * response at all, so there is nothing to redact.
   * @example 'USER'
   */
  role: UserRole;
}

/** The bio column's width. */
export const BIO_MAX_LENGTH = 280;
