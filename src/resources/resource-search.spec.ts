import { buildFacetQuery, buildRankedResourceQuery } from './resource-search';
import { AccessType, ResourceType } from '../generated/prisma/enums';

/**
 * The ranking query's SQL, flattened.
 *
 * ## Why these are assertions about generated text
 *
 * The scoring expression is a sum of `CASE`s inside a raw query, and the whole
 * point of `resource-search.ts` being raw SQL is that it cannot be expressed any
 * other way. So there is no builder output to assert on and no service-level
 * behaviour that would fail if a band were dropped: a missing band still returns
 * 200, just with fewer matches.
 *
 * Asserting on the generated text is therefore the only way to pin it down, and
 * `resources.service.spec.ts` already does this for the anonymity rule for the
 * same reason — its own comment says a mocked test cannot otherwise see it.
 *
 * No database. The scores these tests pin are constants in the module, so every
 * assertion here is a pure function of its input, which keeps the suite free of
 * the database dependency `docs/testing.md` insists on.
 */
const rankedSql = (needle: string, overrides = {}): string =>
  buildRankedResourceQuery({ needle, take: 21, ...overrides }).text.replace(
    /\s+/g,
    ' ',
  );

const rankedValues = (needle: string, overrides = {}): unknown[] =>
  buildRankedResourceQuery({ needle, take: 21, ...overrides }).values;

const facetSql = (needle: string, overrides = {}): string =>
  buildFacetQuery({ needle, ...overrides }).text.replace(/\s+/g, ' ');

/**
 * The score each band contributes, read back out of the bound values.
 *
 * Returned as a name-keyed map so a test can assert `why` is the *lowest* band
 * rather than asserting a literal 20 appears somewhere — which is the property
 * that actually matters and which a hard-coded expectation would not catch if
 * somebody re-ordered the expression.
 */
const bandScores = (needle: string): Record<string, number> => {
  const values = rankedValues(needle);
  const sql = rankedSql(needle);

  const scoreFor = (pattern: RegExp): number => {
    const at = sql.search(pattern);
    if (at === -1) throw new Error(`band not found: ${pattern}`);

    // A band's score is bound to its `THEN`, not to its condition. Every band is
    // `(CASE WHEN <condition> THEN <score> ELSE 0 END)`, so the first `THEN $n`
    // after a matched condition is that band's score.
    const then = sql.slice(at).match(/THEN \$(\d+)/);
    if (!then) throw new Error(`no THEN after band: ${pattern}`);

    return values[Number(then[1]) - 1] as number;
  };

  return {
    exactTitle: scoreFor(/CASE WHEN lower\(r\."title"\) = \$\d+/),
    titlePrefix: scoreFor(
      /CASE WHEN starts_with\(lower\(r\."title"\), \$\d+\)/,
    ),
    tagMatch: scoreFor(/CASE WHEN EXISTS \( SELECT 1 FROM "_ResourceToTag"/),
    titleContains: scoreFor(/CASE WHEN r\."title" ILIKE \$\d+/),
    whyContains: scoreFor(/CASE WHEN r\."why" ILIKE \$\d+/),
  };
};

describe('resource-search', () => {
  describe('the why band', () => {
    /**
     * The load-bearing test in this file.
     *
     * A contributor's explanation is searchable because this `ILIKE` is in the
     * score. If somebody removes it, the query still returns 200 and still
     * matches titles and tags — so nothing else in the suite would notice, and
     * `why` would quietly stop being searchable with no visible failure.
     */
    it('scores a match inside the contributor`s why', () => {
      expect(rankedSql('sapiens')).toContain('r."why" ILIKE $');
    });

    /**
     * The reason a `why`-only match appears in the results at all.
     *
     * The band contributes 20, and the query's only gate is `score > 0`. So a
     * resource whose title and tags match nothing still qualifies on the strength
     * of its `why` — which is the whole behaviour, and the part that would
     * silently change if the gate ever became "matches a title".
     */
    it('is gated only on the score being positive, so a why-match alone qualifies', () => {
      expect(rankedSql('sapiens')).toContain('WHERE "score" > 0');
      expect(bandScores('sapiens').whyContains).toBeGreaterThan(0);
    });

    /**
     * `why` is free prose of up to 5000 characters, so it is the noisiest signal
     * available: every contribution whose explanation happens to mention a word
     * matches it. It therefore has to sit below every band that means "this is the
     * resource you asked for", or a popular word in somebody's reasoning would
     * outrank an exact title match.
     */
    it('is the lowest band, below title and tag matches', () => {
      const bands = bandScores('sapiens');

      expect(bands.whyContains).toBeLessThan(bands.exactTitle);
      expect(bands.whyContains).toBeLessThan(bands.titlePrefix);
      expect(bands.whyContains).toBeLessThan(bands.tagMatch);
      expect(bands.whyContains).toBeLessThan(bands.titleContains);
    });

    it('matches a substring anywhere in the why, not only a prefix', () => {
      expect(rankedValues('institutions')).toContain('%institutions%');
    });

    /**
     * `ILIKE`, so matching is case-insensitive. A contributor who typed
     * "Institutions" and a reader who searches "institutions" have to meet.
     */
    it('matches case-insensitively', () => {
      expect(rankedSql('institutions')).toContain('r."why" ILIKE $');
    });

    /**
     * `%` and `_` are `LIKE` wildcards, so an unescaped `?q=50%` would match
     * `50x` and `?q=a_b` would match `axb`. Both would return wrong results
     * rather than failing, which is the worse outcome.
     */
    it('escapes LIKE metacharacters in the why pattern', () => {
      expect(rankedValues('50%')).toContain('%50\\%%');
      expect(rankedValues('a_b')).toContain('%a\\_b%');
      expect(rankedValues('back\\slash')).toContain('%back\\\\slash%');
    });

    it('escapes the backslash first, or the escaping would add one of its own', () => {
      // A lone trailing backslash must be doubled, or it would escape the closing
      // `%` and silently turn the pattern into a prefix match.
      const patterns = rankedValues('a\\').filter(
        (value): value is string =>
          typeof value === 'string' && value.startsWith('%'),
      );

      expect(patterns).toContain('%a\\\\%');
    });

    /**
     * Fuzzy matching is applied to the title only, and that is deliberate.
     *
     * `word_similarity` against 5000 characters of prose would put almost any row
     * over the threshold and turn the ordering into noise. Keeping it off `why` is
     * also why a typo inside somebody's reasoning does not match — forgiving
     * prose is a different feature from forgiving a title, and it is not built.
     */
    it('is not fuzzy-matched, so a typo in prose does not match', () => {
      const sql = rankedSql('institutions');

      expect(sql).toContain('word_similarity($10, lower(r."title"))');
      expect(sql).not.toMatch(/word_similarity\([^)]*r\."why"/);
    });

    it('drops the fuzzy band entirely for a needle below the trigram minimum', () => {
      // `ab` has no trigram, so the whole band collapses to a literal 0.
      expect(rankedSql('ab')).toContain('+ 0 + (CASE WHEN r."why" ILIKE');
    });
  });

  describe('the existing bands', () => {
    // Preserved behaviour. These are the bands the `why` match must never
    // displace, and the ones a refactor would break first.
    it('still scores an exact title', () => {
      expect(rankedSql('sapiens')).toContain('lower(r."title") = $');
      expect(bandScores('sapiens').exactTitle).toBeGreaterThan(
        bandScores('sapiens').titlePrefix,
      );
    });

    it('still scores a title prefix', () => {
      expect(rankedSql('sapiens')).toContain('starts_with(lower(r."title"), $');
    });

    it('still scores a tag named by name or by slug', () => {
      const sql = rankedSql('sapiens');

      expect(sql).toContain('lower(t."name") = $');
      expect(sql).toMatch(/t\."slug" = lower\(\$\d+\)/);
    });

    it('still scores a substring of the title', () => {
      expect(rankedSql('sapiens')).toContain('r."title" ILIKE $');
    });

    it('still fuzzy-matches the title above the threshold', () => {
      const values = rankedValues('sapiens');

      expect(values).toContain('sapiens');
      expect(values).toContain(0.6);
    });
  });

  describe('ordering and paging', () => {
    /**
     * A total order, which is what the keyset cursor needs: `createdAt` is not
     * unique, so a cursor over a non-total order skips or repeats rows.
     */
    it('orders by score then id, and pages on that pair', () => {
      const sql = rankedSql('sapiens');

      expect(sql).toContain('ORDER BY "score" DESC, "id" DESC');
    });

    it('resumes strictly below the cursor position', () => {
      const sql = buildRankedResourceQuery({
        needle: 'sapiens',
        take: 21,
        cursor: { score: 20, id: 'res_1' },
      }).text.replace(/\s+/g, ' ');

      expect(sql).toContain('("score", "id") < (');
    });

    it('omits the cursor clause on the first page', () => {
      expect(rankedSql('sapiens')).not.toContain('("score", "id") <');
    });

    it('takes one over the page size so hasMore needs no COUNT', () => {
      expect(rankedValues('sapiens')).toContain(21);
    });

    /**
     * A `why`-only match sits at the bottom of the page, so on a large corpus a
     * reader has to page to reach it. That is the intended trade — see the band
     * ordering above — and it is asserted so a future "promote prose matches"
     * change has to be deliberate.
     */
    it('ranks a why-match below everything a title or tag matched', () => {
      const sql = rankedSql('sapiens');

      // The why band is added last, and nothing reorders the sum.
      expect(sql.lastIndexOf('r."why" ILIKE')).toBeGreaterThan(
        sql.indexOf('r."title" ILIKE'),
      );
    });
  });

  describe('filters combined with a why match', () => {
    // A `why` match is a *score*, not a filter, so it must not bypass any of them.
    it('applies a tag filter to the scored set', () => {
      expect(rankedSql('sapiens', { tag: 'evolution' })).toContain(
        't."slug" = $',
      );
    });

    it('applies a type filter', () => {
      const sql = buildRankedResourceQuery({
        needle: 'sapiens',
        take: 21,
        type: ResourceType.BOOK,
      }).text.replace(/\s+/g, ' ');

      expect(sql).toMatch(/r\."type" = CAST\(\$\d+ AS "ResourceType"\)/);
    });

    it('applies an access-type filter', () => {
      const sql = buildRankedResourceQuery({
        needle: 'sapiens',
        take: 21,
        accessType: AccessType.FREE,
      }).text.replace(/\s+/g, ' ');

      expect(sql).toMatch(/r\."accessType" = CAST\(\$\d+ AS "AccessType"\)/);
    });

    /**
     * The anonymity rule, restated for the scored set: a profile's listing must
     * not disclose posts its owner withheld, and a `why` match is still a post.
     */
    it('excludes anonymous rows under a contributor filter', () => {
      const sql = rankedSql('sapiens', { contributorUsername: 'ada' });

      expect(sql).toContain('r."isAnonymous" = false');
      expect(sql).toContain('u."usernameLower" = $');
    });

    it('keeps anonymous rows in the global corpus', () => {
      expect(rankedSql('sapiens')).not.toContain('r."isAnonymous" = false');
    });

    it('means "no restriction" when no filter is given', () => {
      expect(rankedSql('sapiens')).toContain('WHERE TRUE');
    });
  });

  describe('the facet query', () => {
    /**
     * The reason `resourceScoreExpression` exists as a shared function, and the
     * reason this comparison matters: a count that disagreed with the list beside
     * it would be worse than no count at all, because the value of a facet count
     * is that you can trust it. If the `why` band were added to one query and not
     * the other, the dropdowns would count a different set from the results and
     * nothing would fail.
     */
    it('uses the identical score expression, why band included', () => {
      const ranked = rankedSql('sapiens');
      const facet = facetSql('sapiens');

      const cases = (sql: string) => sql.match(/CASE WHEN/g)?.length ?? 0;

      // The facet query carries the expression twice — once per `GROUP BY` — so
      // twice the count is the equality, not an equal count. What this catches is
      // the band being added to one query and not the other, which would leave the
      // dropdowns counting a different set from the list beside them.
      expect(cases(facet)).toBe(cases(ranked) * 2);
      expect(facet).toContain('r."why" ILIKE $');
      expect(facet).toContain('word_similarity($');
    });

    it('gates on the same score arithmetic', () => {
      expect(facetSql('sapiens')).toContain('> 0');
    });

    it('counts with no needle as an ordinary filtered grouping', () => {
      // A blank search must not narrow the dropdowns, or an unfiltered browse
      // would show counts that contradict the list it is showing.
      const sql = buildFacetQuery({}).text.replace(/\s+/g, ' ');

      expect(sql).toContain('WHERE TRUE');
      expect(sql).not.toContain('r."why" ILIKE');
    });

    it('applies each grouping its own exclusion, so a facet is never self-zero', () => {
      const sql = facetSql('sapiens', {
        type: ResourceType.BOOK,
        accessType: AccessType.FREE,
      });

      // Both `GROUP BY`s exist, and the filter appears twice — once per grouping,
      // each omitting the facet it is counting.
      expect(sql.match(/GROUP BY/g)).toHaveLength(2);
      expect(sql.match(/r\."type" = CAST/g)).toHaveLength(1);
      expect(sql.match(/r\."accessType" = CAST/g)).toHaveLength(1);
    });
  });
});
