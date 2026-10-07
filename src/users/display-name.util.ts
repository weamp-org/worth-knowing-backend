/**
 * The two Clerk fields this module reads.
 *
 * Structural rather than `Pick<ClerkUser, ...>` on purpose: `@clerk/backend` is
 * only a transitive dependency of `@clerk/express`, so importing its types
 * directly would need it added as a direct dependency or would break the build.
 * Declaring the shape also documents exactly what is relied on, so a Clerk
 * upgrade that changes `fullName` fails here rather than silently.
 */
export interface ClerkNameFields {
  fullName: string | null;
  username: string | null;
}

/**
 * The first value that is actually a name, or `null`.
 *
 * `??` is not enough on its own. Clerk returns `""` for a field that is present
 * but blank, and a name that is an empty string renders as a byline reading
 * "Shared by " — so blank is treated as absent and the next candidate is tried.
 * Whitespace-only is the same case wearing a disguise.
 */
function firstPresent(...candidates: (string | null)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

/**
 * Where a contributor's display name comes from, and what happens when there
 * isn't one.
 *
 * Two separate questions live here, and keeping them apart is the point:
 *
 * 1. **What do we store?** A Clerk user's name, or nothing. See
 *    {@link clerkDisplayName}.
 * 2. **What do we show?** A display name, resolved on read. See
 *    {@link resolveDisplayName}.
 *
 * The previous code answered both with one expression —
 * `fullName ?? username ?? 'Anonymous'` — copied into `ClerkAuthGuard` and
 * `WebhooksService`. That had three problems: it fabricated an identity and
 * stored it, `'Anonymous'` collided with the product's own anonymity feature
 * (a byline reading "Shared by Anonymous" sits next to "Shared anonymously",
 * meaning two entirely different things), and the duplication meant the two
 * provisioning paths could disagree about what a user is called.
 */

/**
 * The name to store for a Clerk user, or `null` when they have not set one.
 *
 * Returns `null` rather than a placeholder. Every string invented here is a
 * claim about somebody we cannot back up, and this codebase is otherwise careful
 * not to make false claims about people — `isAnonymous` is a deliberate,
 * per-contribution choice, a private profile answers 404 rather than 403 so it
 * does not leak that it exists, and a deleted contributor gets their own
 * distinct wording rather than being called anonymous. Storing "Anonymous" as
 * somebody's name undoes all three in one word.
 *
 * A Clerk `username` is a real name the person chose, so it is kept. Only when
 * there is neither is the answer `null`.
 */
export function clerkDisplayName(user: ClerkNameFields): string | null {
  return firstPresent(user.fullName, user.username);
}

/**
 * The name to show for a user row, or `null` when they have neither.
 *
 * Preference order is deliberate:
 *
 * 1. **Their Clerk name.** The name they gave their account.
 * 2. **Their Worth Knowing handle.** A name they chose here, and the only one
 *    they will have if they signed up without giving a name.
 *
 * The second case is not a gap, it is a guarantee. `/share` is gated on having
 * claimed a username, so anyone who can appear in a byline has one. `null` is
 * therefore only reachable for an account with no contributions at all, viewing
 * its own profile.
 *
 * Resolved on read rather than written at provision time, so the handle a person
 * claims later is picked up without a backfill.
 */
export function resolveDisplayName(
  user: Pick<
    { name: string | null; username: string | null },
    'name' | 'username'
  >,
): string | null {
  return firstPresent(user.name, user.username);
}

/**
 * Where to link a user row's name, or `null` when there is nowhere to go.
 *
 * One nullable path, resolved on the server, so a client has exactly one rule:
 * render an anchor when it is a string. Every caller that showed a user would
 * otherwise re-derive the same decision from two raw fields, and getting it
 * wrong in one of them produces a link to a 404 rather than a wrong-looking page
 * — which is exactly the kind of bug that survives review.
 *
 * Null in three cases, and none of them means the name is hidden:
 *
 * - The profile is private, so the page would not resolve for this viewer. The
 *   name still reads; only the destination goes.
 * - No username has been claimed, so `/u/:username` has nothing to match on.
 * - There is no `usernameLower` at all on a pre-migration row.
 *
 * Whether a name is *shown* is a separate question, answered by `isAnonymous`
 * and by the caller. Keeping the two apart is what stops "there is no link" from
 * being misread as "this person is anonymous".
 */
export function resolveProfilePath(
  user: Pick<
    { usernameLower: string | null; isProfilePrivate: boolean },
    'usernameLower' | 'isProfilePrivate'
  >,
): string | null {
  if (user.isProfilePrivate || user.usernameLower === null) return null;

  return `/u/${user.usernameLower}`;
}
