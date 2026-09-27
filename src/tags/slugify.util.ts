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

/** Combining marks NFKD splits off, e.g. the acute in `é`. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Any Unicode letter or digit, in any script. */
const UNICODE_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * A character outside printable ASCII that the slug allowlist cannot represent.
 * Accented Latin has already been folded to ASCII by this point, so anything
 * still matching belongs to another script (Cyrillic, Greek, CJK, ...).
 */
const NON_ASCII_LETTER_OR_NUMBER = /[^\u0020-\u007e]/u;

/**
 * Folds a name to its NFKD form with combining marks removed.
 *
 * This handles accented Latin (`café` -> `cafe`), full-width forms
 * (`Ｆｕｌｌ` -> `Full`) and ligatures. It does **not** transliterate scripts with
 * no Latin decomposition — Cyrillic, Greek and CJK pass through unchanged.
 */
function foldTagName(name: string): string {
  return name.normalize('NFKD').replace(COMBINING_MARKS, '');
}

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
  return foldTagName(name)
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

/**
 * Whether a name is written in a script we cannot turn into a slug.
 *
 * True when the name contains real letters or digits that survive folding but
 * still normalize away to nothing — Cyrillic, Greek, CJK, and so on. Callers use
 * this to tell "we don't support this script yet" apart from "that is just
 * punctuation", because the two need different messages.
 */
export function isUnsupportedScript(name: string): boolean {
  const folded = foldTagName(name);

  // A real name in another script still has letters or digits, and at least one
  // of them is outside ASCII. Punctuation-only input fails the first test, which
  // is what keeps "!!!" from being reported as an unsupported script.
  return (
    UNICODE_LETTER_OR_NUMBER.test(folded) &&
    NON_ASCII_LETTER_OR_NUMBER.test(folded)
  );
}
