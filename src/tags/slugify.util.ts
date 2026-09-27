/** Lower bound on a tag slug, e.g. `ai`, `r`. */
export const TAG_SLUG_MIN_LENGTH = 2;

/** Upper bound on a tag slug. Keeps tag URLs and the typeahead payload small. */
export const TAG_SLUG_MAX_LENGTH = 40;

/**
 * Characters allowed in a tag slug, in addition to letters, digits and hyphens.
 *
 * `.` and `+` are common in real technical tags (`node.js`, `C++`). `#` is kept
 * so `C#` does not collapse into `c` and collide with the C language tag — but a
 * `#` in a URL path segment starts the fragment, so tag URLs must be built with
 * `encodeURIComponent`.
 */
const DISALLOWED_RUN = /[^a-z0-9.+#-]+/g;
const REPEATED_HYPHENS = /-{2,}/g;
const EDGE_HYPHENS = /^-+|-+$/g;

/**
 * Normalizes a tag name into its URL-safe slug identity.
 *
 * Pure: it never throws and never rejects. Callers validate the result against
 * {@link TAG_SLUG_MIN_LENGTH} / {@link TAG_SLUG_MAX_LENGTH} themselves.
 *
 * Normalizing here also collapses the most common duplicate spelling for free —
 * `"Machine Learning"` and `"machine-learning"` both become `machine-learning`.
 */
export function slugifyTag(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(DISALLOWED_RUN, '-')
    .replace(REPEATED_HYPHENS, '-')
    .replace(EDGE_HYPHENS, '');
}

/** Whether a slug produced by {@link slugifyTag} is a usable tag identity. */
export function isValidTagSlug(slug: string): boolean {
  return (
    slug.length >= TAG_SLUG_MIN_LENGTH && slug.length <= TAG_SLUG_MAX_LENGTH
  );
}
