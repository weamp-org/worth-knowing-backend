/**
 * Username rules.
 *
 * A username is a public handle: it appears in a URL, on somebody's profile, and
 * on every link back to it. Three consequences shape everything here.
 *
 * It is stored twice, as `User.username` (the form as typed, for display) and
 * `User.usernameLower` (the normalized form, which is the only unique one). The
 * split is the same one `Tag.name` / `Tag.slug` already makes, and for the same
 * reason: a unique index is case-sensitive in Postgres, so without a normalized
 * column `AdaL` and `adal` would both be claimable and would then be the same
 * profile by URL.
 *
 * Nothing here throws and nothing here touches the database. Validating shape is
 * a pure function of the input; whether a username is *available* is a question
 * only a query can answer, and lives in `UsersService`.
 */

/** Lower bound. Shorter than this and a handle stops being sayable out loud. */
export const USERNAME_MIN_LENGTH = 3;

/**
 * Upper bound, and the width of the `username` column.
 *
 * 24 is the ceiling Twitter settled on, and it keeps `/u/...` URLs and the
 * reserved-word set small. It is the same reason `TAG_SLUG_MAX_LENGTH` is 40.
 */
export const USERNAME_MAX_LENGTH = 24;

/**
 * The allowed character set, applied to the *normalized* form.
 *
 * Underscore but not hyphen: this is a handle that identifies a person, not a
 * slug that describes a thing, and `@handle` reads correctly with one. Digits
 * are allowed but a username that is *only* digits is not — see
 * {@link isValidUsername}. Periods, `+` and `#` are allowed in tag slugs because
 * they are common in technology names (`node.js`, `C++`); none of them are
 * common in a person's name, and all three are trouble in a URL path or a shell.
 */
const USERNAME_PATTERN = /^[a-z0-9_]+$/;

/** A username that is nothing but digits is a phone number or a year. */
const ALL_DIGITS = /^[0-9]+$/;

/** Combining marks NFKD splits off, e.g. the acute in `é`. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Any Unicode letter or digit, in any script. */
const UNICODE_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * A character outside printable ASCII that the allowlist cannot represent.
 * Accented Latin has already been folded by this point, so anything still
 * matching belongs to another script.
 */
const NON_ASCII_LETTER_OR_NUMBER = /[^ -~]/u;

/**
 * Folds a typed username to its NFKD form with combining marks removed.
 *
 * This handles accented Latin (`Café` -> `Cafe`), full-width forms and
 * ligatures, the same way tag names are folded. It does **not** transliterate
 * scripts with no Latin decomposition — Cyrillic, Greek and CJK pass through
 * unchanged and are then reported by {@link isUnsupportedScript}.
 */
function foldUsername(input: string): string {
  return input.normalize('NFKD').replace(COMBINING_MARKS, '');
}

/**
 * Normalizes a typed username into the pair that gets stored.
 *
 * The display form keeps its case, so a handle chosen as `AdaL` is shown that way
 * while resolving case-insensitively. The normalized form is what the unique
 * index, the reserved-word lookup and the profile URL all use.
 *
 * Pure: it never throws and never rejects, whatever it is handed. Callers check
 * {@link isValidUsername} and {@link isUnsupportedScript} themselves, so a form
 * can tell "that character is not allowed" apart from "we cannot spell your name
 * in our alphabet yet" — two problems with two different fixes.
 */
export function normalizeUsername(input: string): {
  username: string;
  usernameLower: string;
} {
  const username = foldUsername(input).trim();

  return { username, usernameLower: username.toLowerCase() };
}

/**
 * Whether a normalized username is a shape we would issue.
 *
 * Checks the normalized form, so callers do not have to remember to lowercase
 * first and accidentally validate `AdaL` against a lowercase-only pattern.
 */
export function isValidUsername(usernameLower: string): boolean {
  if (usernameLower.length < USERNAME_MIN_LENGTH) return false;
  if (usernameLower.length > USERNAME_MAX_LENGTH) return false;
  if (!USERNAME_PATTERN.test(usernameLower)) return false;
  if (ALL_DIGITS.test(usernameLower)) return false;

  return true;
}

/**
 * Whether a typed username is written in a script we cannot represent.
 *
 * True when it contains real letters or digits that survive folding but still
 * normalize away to nothing — Cyrillic, Greek, CJK, and so on. Callers use this
 * to tell "we don't support that script yet" apart from "that is just
 * punctuation", which matters because the first is a gap we have promised to
 * close and the second is a plain validation error.
 */
export function isUnsupportedScript(input: string): boolean {
  const folded = foldUsername(input);

  // A real name in another script still has letters or digits, and at least one
  // of them is outside ASCII. Punctuation-only input fails the first test, which
  // is what keeps "!!!" from being reported as an unsupported script.
  return (
    UNICODE_LETTER_OR_NUMBER.test(folded) &&
    NON_ASCII_LETTER_OR_NUMBER.test(folded)
  );
}

/**
 * Words we will not issue to anybody, however long the list gets.
 *
 * Two groups, and the second is the one that actually matters:
 *
 * - App routes. Profiles live under `/u/:username`, so these cannot shadow a
 *   page today. They are here because that prefix is the kind of thing that gets
 *   dropped in a redesign, and a user holding `settings` at that point is a
 *   problem nobody remembers having created.
 * - Words that would read as the product or as staff. Nobody should be able to
 *   publish a profile called `admin` or `official`; the failure mode is a
 *   stranger who looks like us.
 *
 * Stored in `ReservedUsername` with reason `RESERVED` rather than checked in
 * code, so that holding a *released* handle is the same operation and the same
 * lookup as holding one of these. See `UsersService.claimUsername`.
 */
export const RESERVED_USERNAMES: readonly string[] = [
  // App routes, present and prospective.
  'about',
  'admin',
  'api',
  'app',
  'contributors',
  'edit',
  'help',
  'login',
  'new',
  'privacy',
  'resources',
  'settings',
  'share',
  'signin',
  'signup',
  'support',
  'terms',
  'u',

  // Would read as the product or as staff.
  'helpdesk',
  'moderator',
  'official',
  'root',
  'security',
  'staff',
  'system',
  'worthknowing',
  'wk',
];

/** The reserved list, folded and lowercased, ready to seed. */
export function normalizedReservedUsernames(): string[] {
  return RESERVED_USERNAMES.map((word) =>
    foldUsername(word).trim().toLowerCase(),
  );
}
