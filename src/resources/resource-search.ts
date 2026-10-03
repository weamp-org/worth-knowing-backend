import { Prisma } from '../generated/prisma/client';

/**
 * Resource search: scoring, and the raw query that applies it.
 *
 * ## Why this is raw SQL
 *
 * Search orders by a **computed** score. Prisma's `orderBy` accepts columns and
 * relation aggregates; it cannot accept an arbitrary expression, so there is no
 * query-builder spelling of "order by how well this row matched". The alternative
 * — fetching every matching row and sorting in JavaScript — is unbounded, which
 * this API deliberately never is.
 *
 * ## Why it returns ids only
 *
 * The query below selects `"id"` and `"score"` and nothing else. The rows are then
 * re-read through Prisma with the ordinary {@link resourceInclude} and passed
 * through {@link toResourceResponse}.
 *
 * That is a deliberate two-step rather than an oversight. Doing it in one step
 * means writing the contributor join, the anonymity rule and the display-name
 * resolution a second time in SQL, and the anonymity rule is exactly the kind of
 * thing that must exist once. `resourceInclude` and `toResourceResponse` are shared
 * with collections and profiles precisely so that the rule has a single home;
 * a raw-SQL search that reimplemented them would reintroduce the second copy the
 * module was extracted to eliminate.
 *
 * Two round trips at a page size of 20–100 is not a cost worth optimising away
 * against a correctness guarantee.
 */

/** The whole title is the query. Nothing outranks this. */
const SCORE_EXACT_TITLE = 100;

/** The title starts with the query. */
const SCORE_TITLE_PREFIX = 80;

/**
 * A tag is named exactly by the query.
 *
 * Scored on the tag's display `name` and on its `slug`, because a person who has
 * seen `machine-learning` in a URL will type that and a person who sees the
 * vocabulary on a tag chip will type `Machine Learning`. Both are how the same
 * tag is written down here, so both have to match.
 */
const SCORE_TAG_MATCH = 70;

/** The query appears somewhere inside the title. */
const SCORE_TITLE_CONTAINS = 60;

/**
 * The title is *nearly* the query — a typo, or a plural, or a hyphenated variant.
 *
 * See {@link FUZZY_THRESHOLD} for why this band is the one to distrust.
 */
const SCORE_TITLE_FUZZY = 40;

/**
 * The query appears in the `why` — the contributor's explanation.
 *
 * Lowest band on purpose. `why` is free prose of up to 5000 characters, so this
 * is the noisiest possible signal: every contribution whose explanation mentions
 * "introduction" matches a search for `introduction`, regardless of what the
 * resource is. It ranks last so it only decides the order of results that nothing
 * better matched, and it never promotes a row on its own above anything that
 * matched a title or a tag.
 */
const SCORE_WHY_CONTAINS = 20;

/**
 * Trigram similarity above which a title counts as a near-match.
 *
 * Measured against a seeded corpus rather than guessed, which was worth doing
 * because trigram similarity behaves very unevenly across typo kinds. Scored
 * with `word_similarity` against the title `Sapiens`:
 *
 * | needle     | score | typo                     |
 * |------------|-------|--------------------------|
 * | `sapien`   | 0.857 | dropped character       |
 * | `sapienss` | 0.778 | doubled character       |
 * | `sapienz`  | 0.750 | substitution at the end  |
 * | `sapiem`   | 0.714 | transposition            |
 * | `xapiens`  | 0.625 | extra leading character |
 * | -          | 0.600 | **threshold**           |
 * | `sapine`   | 0.571 | missed (truncated twice) |
 * | `sapines`  | 0.500 | missed (transposition)  |
 * | `sapenus`  | 0.375 | missed (transposition)  |
 *
 * 0.6 catches substitution, insertion, deletion and some transposition, and
 * measured **no false positives** against unrelated titles at that level.
 *
 * Transposition is the known weak spot and this does not fix it: swapping two
 * adjacent characters destroys most of the trigrams on both sides, so a
 * transposition can score barely above chance however low the threshold goes.
 * Lowering it to catch `sapenus` drags in `sapine` and the rest of that band,
 * and the failure is asymmetric — too loose and the whole ranking becomes noise
 * ordered by nothing, too tight and search merely under-delivers on forgiveness.
 * Trigram matching was chosen knowing this; forgiving every transposition would
 * need Levenshtein, which Postgres has no built-in for.
 */
const FUZZY_THRESHOLD = 0.6;

/**
 * Shortest query that can be fuzzy-matched at all.
 *
 * A trigram is three characters, so `word_similarity` has nothing to work with
 * below that — and a two-character needle matches a trigram window of almost any
 * title, which would put half the table in the fuzzy band.
 */
const FUZZY_MIN_QUERY_LENGTH = 3;

/**
 * Escapes the LIKE metacharacters in a user-supplied needle.
 *
 * `%` and `_` are wildcards, so an unescaped `?q=50%` would match `50x` and an
 * unescaped `?q=a_b` would match `axb`. Neither is what the person meant, and
 * both silently return wrong results rather than failing loudly. The backslash
 * itself has to be escaped first or it would be added by this function's own
 * replacement.
 */
function containsPattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
}

/** One row of {@link buildRankedResourceQuery}. */
export interface RankedResource {
  id: string;
  score: number;
}

export interface RankedSearchQuery {
  /** Already trimmed. Empty is not a search — the caller decides that. */
  needle: string;
  /** One over the page size, so `hasMore` needs no `COUNT(*)`. */
  take: number;
  tag?: string;
  /** See the anonymity note in the query body. */
  contributorUsername?: string;
  cursor?: { score: number; id: string };
}

/**
 * Builds the ranked search query.
 *
 * Ordering is `(score DESC, id DESC)` — a total order, which is what a keyset
 * cursor needs. `id` is a cuid and roughly time-ordered, so the tiebreak
 * approximates newest-first among equal scores; the property that actually
 * matters is only that it is a strict total order, because `createdAt` is not
 * unique and a cursor over a non-total order skips or repeats rows.
 */
export function buildRankedResourceQuery({
  needle,
  take,
  tag,
  contributorUsername,
  cursor,
}: RankedSearchQuery): Prisma.Sql {
  const filters: Prisma.Sql[] = [];

  if (tag) {
    filters.push(Prisma.sql`
      EXISTS (
        SELECT 1 FROM "_ResourceToTag" rt
        JOIN "Tag" t ON t."id" = rt."B"
        WHERE rt."A" = r."id" AND t."slug" = ${tag}
      )
    `);
  }

  if (contributorUsername) {
    filters.push(Prisma.sql`
      r."isAnonymous" = false
      AND EXISTS (
        SELECT 1 FROM "User" u
        WHERE u."id" = r."contributorId"
          AND u."usernameLower" = ${contributorUsername}
      )
    `);
    /*
     * `isAnonymous = false` here for the same reason the unfiltered Prisma path
     * sets it, and it is the same reason it is *only* here: a profile's listing
     * must not disclose the existence of posts its owner chose to withhold,
     * while the global corpus is public content that happens to be unattributed.
     * A search over everything is the global corpus, so it keeps anonymous
     * resources. Narrowing to one contributor is the case that excludes them.
     *
     * Duplicated as SQL rather than shared with the Prisma path because a
     * `Prisma.ResourceWhereInput` cannot become a SQL fragment. The reasoning is
     * the load-bearing part and it is written out in `ResourcesService.findAll`
     * as well; if one side changes, the other has to.
     */
  }

  // At least one row is required by `WHERE`, and "no filters" has to mean "no
  // restriction" rather than "no rows".
  const where =
    filters.length > 0 ? Prisma.join(filters, ' AND ') : Prisma.sql`TRUE`;

  const fuzzyTerm =
    needle.length >= FUZZY_MIN_QUERY_LENGTH
      ? Prisma.sql`
          (CASE WHEN word_similarity(${needle}, lower(r."title")) > ${FUZZY_THRESHOLD}
                THEN ${SCORE_TITLE_FUZZY} ELSE 0 END)`
      : Prisma.sql`0`;

  return Prisma.sql`
    WITH scored AS (
      SELECT
        r."id" AS "id",
        (
          (CASE WHEN lower(r."title") = ${needle} THEN ${SCORE_EXACT_TITLE} ELSE 0 END)
          + (CASE WHEN starts_with(lower(r."title"), ${needle}) THEN ${SCORE_TITLE_PREFIX} ELSE 0 END)
          + (CASE WHEN EXISTS (
              SELECT 1 FROM "_ResourceToTag" rt
              JOIN "Tag" t ON t."id" = rt."B"
              WHERE rt."A" = r."id"
                AND (lower(t."name") = ${needle} OR t."slug" = lower(${needle}))
            ) THEN ${SCORE_TAG_MATCH} ELSE 0 END)
          + (CASE WHEN r."title" ILIKE ${containsPattern(needle)} ESCAPE '\\'
                  THEN ${SCORE_TITLE_CONTAINS} ELSE 0 END)
          + ${fuzzyTerm}
          + (CASE WHEN r."why" ILIKE ${containsPattern(needle)} ESCAPE '\\'
                  THEN ${SCORE_WHY_CONTAINS} ELSE 0 END)
        ) AS "score"
      FROM "Resource" r
      WHERE ${where}
    )
    SELECT "id", "score"
    FROM scored
    WHERE "score" > 0
    ${
      // Row-value comparison is the whole cursor mechanism: it resumes strictly
      // below `(score, id)` in the same `(score DESC, id DESC)` order the page was
      // sorted by, so no row is served twice and none is skipped.
      cursor
        ? Prisma.sql`AND ("score", "id") < (${cursor.score}, ${cursor.id})`
        : Prisma.empty
    }
    ORDER BY "score" DESC, "id" DESC
    LIMIT ${take}
  `;
}
