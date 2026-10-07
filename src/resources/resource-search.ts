import { Prisma } from '../generated/prisma/client';
import { AccessType, ResourceType } from '../generated/prisma/enums';

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

/**
 * How many resources match, grouped by one of the two filterable facets.
 *
 * Returned as sparse rows rather than a dense map so the service can fill the gaps
 * itself: a value with no matching resources has no row at all, and an enum is
 * wider than the set of values anyone has actually used.
 */
export interface ResourceFacetRow {
  /** `"type"` or `"accessType"` — which facet this row belongs to. */
  facet: string;
  value: string;
  count: number;
}

export interface FacetQueryOptions {
  /** Already trimmed. Absent means "no search", which counts every matching row. */
  needle?: string;
  tag?: string;
  contributorUsername?: string;
  /**
   * The facet's own filter, applied to **neither** grouping.
   *
   * This is the whole design and it is why the two groupings differ in their
   * filters. A count that excluded its own filter would be self-contradictory —
   * with `type=BOOK` active, every non-book option would read `(0)`, which is
   * true, answers nothing, and makes the dropdown useless exactly when it is being
   * used to change its mind. So each grouping applies every filter *except* the one
   * it is counting.
   */
  type?: ResourceType;
  accessType?: AccessType;
}

/**
 * Builds the grouped counts behind the filter dropdowns.
 *
 * Two `GROUP BY`s over one filtered set, which is one scan rather than fifteen.
 *
 * ## The score is computed once and both groupings use it
 *
 * The search side of a facet count is the *same* predicate {@link
 * buildRankedResourceQuery} uses, and it has to be the same one: a count that
 * disagreed with the list beside it would be worse than no count at all, because
 * the whole value of a facet count is that you can trust it. Writing it separately
 * would be the second copy of the scoring rules that `resource-search.ts` was
 * written to prevent — the same hazard `redactAnonymous` is shared to avoid.
 *
 * With no `needle` the predicate is `TRUE` and this degenerates to an ordinary
 * filtered `GROUP BY`, which is the right behaviour rather than a special case:
 * the dropdowns on an unfiltered browse still have to be honest.
 */
export function buildFacetQuery({
  needle,
  tag,
  contributorUsername,
  type,
  accessType,
}: FacetQueryOptions): Prisma.Sql {
  /*
   * The anonymity rule, restated from {@link buildRankedResourceQuery} and for the
   * same reason: a profile's listing must not disclose the existence of posts its
   * owner withheld. The global corpus keeps them, because an anonymous post is
   * public content that merely goes unattributed.
   */
  const contributorFilter = contributorUsername
    ? Prisma.sql`
        r."isAnonymous" = false
        AND EXISTS (
          SELECT 1 FROM "User" u
          WHERE u."id" = r."contributorId"
            AND u."usernameLower" = ${contributorUsername}
        )
      `
    : Prisma.empty;

  const tagFilter = tag
    ? Prisma.sql`
        EXISTS (
          SELECT 1 FROM "_ResourceToTag" rt
          JOIN "Tag" t ON t."id" = rt."B"
          WHERE rt."A" = r."id" AND t."slug" = ${tag}
        )
      `
    : Prisma.empty;

  // Same `CAST` reasoning as the ranked query: Prisma binds a string, and there is
  // no implicit cast from `text` to an enum in Postgres.
  const typeFilter = type
    ? Prisma.sql`r."type" = CAST(${type} AS "ResourceType")`
    : Prisma.empty;

  const accessTypeFilter = accessType
    ? Prisma.sql`r."accessType" = CAST(${accessType} AS "AccessType")`
    : Prisma.empty;

  const shared: Prisma.Sql[] = [contributorFilter, tagFilter].filter(
    (clause) => clause !== Prisma.empty,
  );

  /*
   * Every base filter, then whichever facet's filter this grouping is *not* counting.
   *
   * Written as "all of them except one" rather than the reverse, so adding a filter
   * cannot accidentally leave it out of both groupings.
   */
  const filtersFor = (excluded: 'type' | 'accessType') => {
    const clauses: Prisma.Sql[] = [
      ...shared,
      ...(excluded === 'type' ? [accessTypeFilter] : [typeFilter]),
    ].filter((clause) => clause !== Prisma.empty);

    return clauses.length > 0
      ? Prisma.join(clauses, ' AND ')
      : Prisma.sql`TRUE`;
  };

  /*
   * The search predicate, isolated so both groupings score identically.
   *
   * `score > 0` rather than a `WHERE` on the same terms spelled out again, so it
   * reads as the same arithmetic as the ranked query rather than as a parallel
   * implementation of it.
   *
   * Wrapped in a `SELECT` because the expression is a sum of `CASE`s and cannot be
   * compared inline: Postgres has no `boolean > integer` operator, so
   * `(CASE … END) > 0` is a type error rather than a filter. The extra subquery is
   * inlined by the planner, so it costs nothing.
   */
  const matchesSearch = needle
    ? Prisma.sql`(${scoreExpressionSubquery(needle)}) > 0`
    : Prisma.sql`TRUE`;

  return Prisma.sql`
    SELECT 'type'::text AS "facet", "type"::text AS "value", COUNT(*)::int AS "count"
    FROM "Resource" r
    WHERE ${filtersFor('type')} AND ${matchesSearch}
    GROUP BY "type"

    UNION ALL

    SELECT 'accessType'::text AS "facet", "accessType"::text AS "value", COUNT(*)::int AS "count"
    FROM "Resource" r
    WHERE ${filtersFor('accessType')} AND ${matchesSearch}
    GROUP BY "accessType"
  `;
}

/**
 * The scoring expression, as a reusable SQL fragment.
 *
 * Exists so {@link buildRankedResourceQuery} and {@link buildFacetQuery} cannot
 * drift. A facet count is only worth showing if it agrees with the list next to
 * it, and two hand-written copies of six scoring bands is precisely how that
 * agreement would be lost — one of them edited, the other not, and nothing failing.
 *
 * Both wrap this in the same `> 0` test, so "matched" is defined in one place.
 */
function resourceScoreExpression(needle: string): Prisma.Sql {
  const fuzzyTerm =
    needle.length >= FUZZY_MIN_QUERY_LENGTH
      ? Prisma.sql`
          (CASE WHEN word_similarity(${needle}, lower(r."title")) > ${FUZZY_THRESHOLD}
                THEN ${SCORE_TITLE_FUZZY} ELSE 0 END)`
      : Prisma.sql`0`;

  return Prisma.sql`
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
    )
  `;
}

/**
 * Every resource type, with how many match.
 *
 * Dense, and that is the point: a facet with no row is a facet that answers
 * nothing, and `(0)` is a real answer. The alternative — omitting empties — would
 * make an option vanish exactly when someone is wondering whether it is worth
 * clicking.
 */
export interface ResourceFacets {
  byType: Record<ResourceType, number>;
  byAccessType: Record<AccessType, number>;
}

/**
 * The same score, lifted into its own scalar subquery so it can be compared.
 *
 * {@link resourceScoreExpression} is a sum of `CASE` expressions, and `CASE` cannot
 * appear inside a scalar subquery's `SELECT` list — only a column or expression
 * over columns, which this is. `SELECT (expr)` is valid; it is the *inline* form
 * `(expr) > 0` that fails, because Postgres has no `boolean > integer` operator.
 *
 * Exists so the facet query reuses the ranked query's arithmetic rather than
 * restating it, which is the whole reason a count can be trusted to agree with the
 * list beside it. Postgres inlines the subquery into the outer `WHERE`, so this is
 * free at runtime.
 */
function scoreExpressionSubquery(needle: string): Prisma.Sql {
  return Prisma.sql`(SELECT ${resourceScoreExpression(needle)})`;
}

export interface RankedSearchQuery {
  /** Already trimmed. Empty is not a search — the caller decides that. */
  needle: string;
  /** One over the page size, so `hasMore` needs no `COUNT(*)`. */
  take: number;
  tag?: string;
  /** See the anonymity note in the query body. */
  contributorUsername?: string;
  type?: ResourceType;
  accessType?: AccessType;
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
  type,
  accessType,
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

  /*
   * The enum filters need an explicit cast.
   *
   * Prisma binds a JavaScript string, so `"type" = $1` compares `text` against
   * `ResourceType` and Postgres rejects it — there is no implicit cast between an
   * enum and text. `CAST(... AS "ResourceType")` says what is meant and lets
   * Postgres validate the value while it is there, which is why this is a cast
   * rather than a string-interpolated literal: an enum value that somehow did not
   * exist becomes a database error rather than a silently-empty result set.
   *
   * The alternative would be `${type}::"ResourceType"`, which is the same thing
   * written shorter and casts less legibly.
   */
  if (type) {
    filters.push(Prisma.sql`r."type" = CAST(${type} AS "ResourceType")`);
  }

  if (accessType) {
    filters.push(
      Prisma.sql`r."accessType" = CAST(${accessType} AS "AccessType")`,
    );
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

  return Prisma.sql`
    WITH scored AS (
      SELECT
        r."id" AS "id",
        ${resourceScoreExpression(needle)} AS "score"
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
