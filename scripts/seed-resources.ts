/**
 * Prints a set of dev resources as SQL, for `prisma db execute`.
 *
 *   pnpm seed:resources
 *
 * Empties `Resource` first. That is the difference between this and
 * `seed:reserved-usernames`, which appends: a dev seed that only ever inserts
 * leaves the feed full of yesterday's rows after the first edit, so a second run
 * would double every resource rather than refresh the set. The rows this creates
 * are all fictional and all identifiable by the `seed-` prefix on their ids, so
 * the delete is scoped to exactly those and can never touch a real contribution.
 *
 * Tags are seeded alongside, because a resource without tags renders as a bare
 * card and gives no idea of what the tag filter looks like.
 *
 * Same piping constraint as the other seeds: the generated Prisma client cannot
 * be imported from a bare `ts-node` script, so this prints SQL instead.
 */
import type { AccessType, ResourceType } from '../src/generated/prisma/enums';

/**
 * Escapes a value for a SQL string literal.
 *
 * Same reasoning as `seed-reserved-usernames.ts`: this is generated SQL going
 * into a `db execute` call, so the escaping is not left to hold only because a
 * constraint happens to forbid the characters that would need it.
 */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `now() - interval` is used instead of a literal so rows stay relative to today. */
function daysAgo(days: number): string {
  return `now() - interval '${days} days'`;
}

interface Seed {
  id: string;
  title: string;
  url: string;
  type: ResourceType;
  accessType: AccessType;
  /** Days before now. Spreads rows out so keyset pagination is worth exercising. */
  ageDays: number;
  why: string;
  contributor: 'ada' | 'grace' | null;
  anonymous?: boolean;
  tags: string[];
}

const contributors = {
  ada: 'seed-user-ada',
  grace: 'seed-user-grace',
} as const;

/**
 * A spread across types, access levels, contributors and dates on purpose.
 *
 * A dev seed of twenty book links tells you nothing about how the feed actually
 * looks. This covers every `ResourceType`, both free and paid, an anonymously
 * shared row, both contributors, and a month of dates so "load more" has
 * something to load.
 */
const seeds: Seed[] = [
  {
    id: 'seed-sapiens',
    title: 'Sapiens: A Brief History of Humankind',
    url: 'https://www.goodreads.com/book/show/33710.Sapiens',
    type: 'BOOK',
    accessType: 'PAID',
    ageDays: 28,
    why: 'The clearest account of how human institutions co-evolved that I have read. It is a popular book and still the one I hand people first.',
    contributor: 'ada',
    tags: ['history', 'anthropology', 'evolution'],
  },
  {
    id: 'seed-society-of-feeds',
    title: 'Seeing Like a State',
    url: 'https://en.wikipedia.org/wiki/Seeing_Like_a_State',
    type: 'BOOK',
    accessType: 'FREE',
    ageDays: 26,
    why: 'Every time I think about a metric that has quietly replaced the thing it was measuring, this is where I go back to.',
    contributor: 'ada',
    tags: ['politics', 'sociology'],
  },
  {
    id: 'seed-agent-based',
    title: 'NetLogo: Agent-Based Modeling',
    url: 'https://ccl.northwestern.edu/netlogo/',
    type: 'TOOL',
    accessType: 'FREE',
    ageDays: 24,
    why: 'Free, and you can watch the model run while you change it. The first time a rule-based simulation clicked for me was dragging a slider here.',
    contributor: 'grace',
    tags: ['simulation', 'complexity', 'programming'],
  },
  {
    id: 'seed-tufte',
    title: 'The Visual Display of Quantitative Information',
    url: 'https://www.edwardtufte.com/bars/graphs/',
    type: 'BOOK',
    accessType: 'PAID',
    ageDays: 21,
    why: 'The chapter on data-ink ratio is the shortest argument against most dashboards ever written.',
    contributor: 'ada',
    tags: ['data-visualization', 'design'],
  },
  {
    id: 'seed-oimo',
    title: 'The Organic Chemistry Tutor',
    url: 'https://www.youtube.com/@theorganicchemistrytutor',
    type: 'VIDEO',
    accessType: 'FREE',
    ageDays: 19,
    why: 'Mechanism problems, worked slowly, no shortcuts. He says the thing I could not articulate about why resonance arrows work.',
    contributor: 'grace',
    tags: ['chemistry', 'education', 'video'],
  },
  {
    id: 'seed-3blue1brown',
    title: 'Essence of Calculus, Chapter 1',
    url: 'https://www.3blue1brown.com/topics/calculus',
    type: 'VIDEO',
    accessType: 'FREE',
    ageDays: 17,
    why: 'I had done this calculus twice before and this is the version where the derivative stopped being a formula.',
    contributor: 'ada',
    tags: ['mathematics', 'video', 'education'],
  },
  {
    id: 'seed-ylearning',
    title: 'Eloquent JavaScript, 4th edition',
    url: 'https://eloquentjavascript.net/',
    type: 'BOOK',
    accessType: 'FREE',
    ageDays: 15,
    why: 'Free online, and the exercises are the point. Reading it without doing them is a waste of the author’s time.',
    contributor: 'grace',
    tags: ['programming', 'javascript'],
  },
  {
    id: 'seed-graphpaper',
    title: 'How to Take Smart Notes',
    url: 'https://takesmartnotes.com/',
    type: 'BOOK',
    accessType: 'PAID',
    ageDays: 13,
    why: 'The argument that notes should be written for a future self who has forgotten everything, which is the only self you ever have.',
    contributor: 'ada',
    tags: ['writing', 'learning', 'productivity'],
  },
  {
    id: 'seed-pandas',
    title: 'pandas: powerful Python data analysis',
    url: 'https://pandas.pydata.org/docs/',
    type: 'WEBSITE',
    accessType: 'FREE',
    ageDays: 11,
    why: 'The cookbook is the documentation. I have landed on it more than once for a problem I thought I understood.',
    contributor: 'grace',
    tags: ['programming', 'data-analysis', 'python'],
  },
  {
    id: 'seed-anon-audit',
    title: 'An internal look at why we keep failing at the same things',
    url: 'https://example.com/worth-knowing/audit-notes',
    type: 'ARTICLE',
    accessType: 'FREE',
    ageDays: 9,
    why: 'Anonymous because it is about my own workplace and I do not want the name attached to it. The write-up is careful in a way the internal version was not.',
    contributor: 'ada',
    anonymous: true,
    tags: ['work', 'writing'],
  },
  {
    id: 'seed-carbon',
    title: 'The Carbon Brief: state of the climate',
    url: 'https://www.thecarbonbrief.org/',
    type: 'WEBSITE',
    accessType: 'FREE',
    ageDays: 7,
    why: 'Cites its sources properly, which is why I can check it instead of trusting it. Rare for a climate summary.',
    contributor: 'grace',
    tags: ['climate', 'data-visualization', 'journalism'],
  },
  {
    id: 'seed-dune',
    title: 'Children of Dune',
    url: 'https://www.goodreads.com/book/show/441218.Children_of_Dune',
    type: 'BOOK',
    accessType: 'PAID',
    ageDays: 5,
    why: 'The one place the series slows down long enough to explain what it is doing. Worth it for that alone.',
    contributor: 'ada',
    tags: ['fiction', 'science-fiction'],
  },
  {
    id: 'seed-sql',
    title: 'Use The Index, Luke!',
    url: 'https://use-the-index-luke.com/',
    type: 'WEBSITE',
    accessType: 'FREE',
    ageDays: 4,
    why: 'Every page has a benchmark. Having the number instead of an intuition is what made indexes click.',
    contributor: 'grace',
    tags: ['databases', 'programming', 'performance'],
  },
  {
    id: 'seed-sketchnotes',
    title: 'Sketchnotes for HCI',
    url: 'https://www.sketchingideas.com/',
    type: 'RESEARCH_PAPER',
    accessType: 'FREE',
    ageDays: 3,
    why: 'Not a book — it is a deck of sketchnotes. The oldest idea in it is still the best way to open a design conversation.',
    contributor: 'ada',
    tags: ['design', 'hci', 'visualization'],
  },
  {
    id: 'seed-bbce',
    title: 'But what is a computer science conceptualization?',
    url: 'https://www.bbce.ac.uk/school/computing/cs-conceptualisation',
    type: 'RESEARCH_PAPER',
    accessType: 'FREE',
    ageDays: 2,
    why: 'Reshaped how I explain CS to people who came at it sideways. It is why this site values the reasoning over the link.',
    contributor: 'grace',
    tags: ['computer-science', 'education', 'pedagogy'],
  },
  {
    id: 'seed-crash',
    title: 'The Past Is a Foreign Country — Revisited',
    url: 'https://www.davidmegginson.com/2023/06/21/the-past-is-a-foreign-country.html',
    type: 'ARTICLE',
    accessType: 'FREE',
    ageDays: 1,
    why: 'On archival sources being misread by people who never learned to read them. Applies well beyond history.',
    contributor: 'ada',
    tags: ['writing', 'journalism', 'history'],
  },
  {
    id: 'seed-kaggle',
    title: 'Kaggle: Titanic survival prediction',
    url: 'https://www.kaggle.com/competitions/titanic',
    type: 'DATASET',
    accessType: 'FREE',
    ageDays: 1,
    why: 'Still the best tutorial dataset for learning a whole toolchain end to end. Boring in exactly the right way.',
    contributor: 'grace',
    tags: ['data-analysis', 'machine-learning', 'python'],
  },
  {
    id: 'seed-wikipedia',
    title: 'Wikipedia: List of common misconceptions',
    url: 'https://en.wikipedia.org/wiki/List_of_common_misconceptions',
    type: 'WEBSITE',
    accessType: 'FREE',
    ageDays: 0,
    why: 'Each entry cites the study that settled it. Half the things I "knew" were on this list and wrong.',
    contributor: 'ada',
    tags: ['reference', 'science', 'writing'],
  },
  {
    id: 'seed-podcast',
    title: 'The Hidden Cost of Convenience',
    url: 'https://example.com/worth-knowing/hidden-cost',
    type: 'PODCAST',
    accessType: 'FREE',
    ageDays: 0,
    why: 'An hour, and the middle third is a conversation between two people who disagree productively. Rare.',
    contributor: 'grace',
    tags: ['podcast', 'technology'],
  },
];

/**
 * Tags, derived from the seeds rather than written twice.
 *
 * `slug` is the normalized identity and `name` the display form, mirroring how a
 * real contribution creates them — so the feed renders the display form and the
 * filter matches on the slug.
 *
 * The id is supplied rather than defaulted, because `Tag.id` uses Prisma's
 * `@default(cuid())` — a client-side default that has no database equivalent, so
 * a raw INSERT would leave the primary key NULL. Every tag here is also given a
 * `seed-` id so re-running can identify dev rows from real ones.
 */
const tags = [...new Set(seeds.flatMap((seed) => seed.tags))].sort();

const tagRows = tags
  .map(
    (slug) =>
      `    (${sqlString(`seed-tag-${slug}`)}, ${sqlString(slug)}, ${sqlString(
        slug
          .split('-')
          .map((word) => word[0].toUpperCase() + word.slice(1))
          .join(' '),
      )}, now())`,
  )
  .join(',\n');

const resourceRows = seeds
  .map((seed) => {
    const anonymous = seed.anonymous ?? false;
    // An anonymously shared resource keeps its contributor relation — that is
    // what lets the author find and edit it — while public responses withhold
    // it. Seeding it with the contributor dropped would produce a row the
    // product can never explain.
    const contributorId =
      seed.contributor === null
        ? 'NULL'
        : sqlString(contributors[seed.contributor]);

    return [
      `    (`,
      `      ${sqlString(seed.id)},`,
      `      ${sqlString(seed.title)},`,
      `      ${sqlString(seed.url)},`,
      `      '${seed.type}'::"ResourceType",`,
      `      '${seed.accessType}'::"AccessType",`,
      `      ${sqlString(seed.why)},`,
      `      ${anonymous},`,
      `      ${contributorId},`,
      `      ${daysAgo(seed.ageDays)},`,
      `      ${daysAgo(seed.ageDays)}`,
      `    )`,
    ].join('\n');
  })
  .join(',\n');

/**
 * The implicit many-to-many Prisma owns for tags.
 *
 * Both columns are **ids**, not slugs: `_ResourceToTag_A_fkey` points at
 * `Resource(id)` and `_ResourceToTag_B_fkey` at `Tag(id)`. A seed that joins on
 * the slug looks right and fails on the foreign key.
 */
const tagLinks = seeds
  .flatMap((seed) =>
    seed.tags.map(
      (tag) => `    (${sqlString(seed.id)}, ${sqlString(`seed-tag-${tag}`)})`,
    ),
  )
  .join(',\n');

process.stdout.write(
  [
    '-- Seeds a set of dev resources, tags and their links. Safe to re-run.',
    '-- Generated by scripts/seed-resources.ts. All rows are fictional and all',
    '-- ids start with "seed-", so the deletes below cannot touch real data.',
    'BEGIN;',
    '',
    '-- Only dev rows. A real contribution is never removed by re-running this.',
    'DELETE FROM "_ResourceToTag" WHERE "B" IN (SELECT id FROM "Resource" WHERE id LIKE \'seed-%\');',
    'DELETE FROM "Resource" WHERE id LIKE \'seed-%\';',
    'DELETE FROM "SavedResource" WHERE "resourceId" LIKE \'seed-%\';',
    '',
    '-- Contributors. "User.id" IS the Clerk user id and there is no local',
    '-- mapping, so these are invented ids that can never be signed in to. That',
    '-- is fine for browsing a feed and means a seed can never collide with a',
    '-- real account.',
    'INSERT INTO "User" (id, email, name, "usernameLower")',
    'VALUES',
    `    (${sqlString(contributors.ada)}, 'ada@example.com', 'Ada Lovelace', 'ada'),`,
    `    (${sqlString(contributors.grace)}, 'grace@example.com', 'Grace Hopper', 'grace')`,
    'ON CONFLICT (id) DO NOTHING;',
    '',
    '-- Tags. "slug" is the identity, "name" the display form, matching how a',
    '-- real contribution creates them.',
    '--',
    '-- "createdAt" is omitted because the column has DEFAULT CURRENT_TIMESTAMP,',
    '-- but "id" and "updatedAt" are supplied: both are Prisma-managed rather than',
    '-- database-managed, so a raw INSERT has to provide them.',
    'INSERT INTO "Tag" (id, slug, name, "updatedAt")',
    'VALUES',
    tagRows,
    'ON CONFLICT (slug) DO NOTHING;',
    '',
    '-- "updatedAt" is set explicitly because Prisma maintains it on write and a',
    '-- raw INSERT would otherwise leave it NULL against a NOT NULL column.',
    'INSERT INTO "Resource" (id, title, url, type, "accessType", "why", "isAnonymous", "contributorId", "createdAt", "updatedAt")',
    'VALUES',
    resourceRows,
    'ON CONFLICT (id) DO NOTHING;',
    '',
    '-- The implicit many-to-many Prisma owns for tags.',
    'INSERT INTO "_ResourceToTag" ("A", "B")',
    'VALUES',
    tagLinks,
    'ON CONFLICT DO NOTHING;',
    '',
    'COMMIT;',
    '',
  ].join('\n'),
);
