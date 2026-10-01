# Prisma ORM

## Overview

The project uses [Prisma v7](https://www.prisma.io/) as the database ORM with PostgreSQL. Key design decisions:

- **`@prisma/adapter-pg`** — Uses Prisma's driver adapter for the `pg` Node.js driver instead of the built-in query engine. This is Prisma v7's recommended approach for new projects.
- **`moduleFormat = "cjs"`** — The generated client uses CommonJS because NestJS runs on a CJS toolchain and `nodenext` module resolution in TypeScript requires explicit `.js` extensions for ESM imports.

---

## Schema (`prisma/schema.prisma`)

```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}

enum UserRole {
  USER
  ADMIN
}

enum ReservedUsernameReason {
  RESERVED
  RELEASED
}

enum ResourceType {
  ARTICLE
  BOOK
  COURSE
  VIDEO
  PODCAST
  PLAYLIST
  TOOL
  RESEARCH_PAPER
  DATASET
  WEBSITE
  OTHER
}

enum AccessType {
  FREE
  PAID
  FREEMIUM
  UNKNOWN
}

model User {
  // Clerk-owned. Rewritten by `WebhooksService` on every Clerk event.
  id       String  @id
  name     String
  email    String  @unique
  imageUrl String?

  // Ours. Display form as typed, then the normalized unique identity.
  username      String? @db.VarChar(24)
  usernameLower String? @unique
  bio           String? @db.VarChar(280)

  isProfilePrivate Boolean @default(false)
  createdAt        DateTime @default(now())

  role                UserRole @default(USER)
  anonymousByDefault  Boolean  @default(false)

  resources  Resource[]
  collections Collection[]
}

/// Every username that must not be claimable, whether or not anyone holds it.
model ReservedUsername {
  usernameLower String                  @id
  reason        ReservedUsernameReason
  createdAt     DateTime                @default(now())
}

model Resource {
  id         String       @id @default(cuid())
  title      String       @db.VarChar(200)
  url        String
  type       ResourceType
  accessType AccessType   @default(UNKNOWN)
  why        String
  isAnonymous Boolean     @default(false)
  createdAt  DateTime     @default(now())
  updatedAt  DateTime     @updatedAt

  contributorId String?
  contributor   User?   @relation(fields: [contributorId], references: [id], onDelete: SetNull)

  tags Tag[]

  @@index([contributorId, createdAt(sort: Desc), id(sort: Desc)])
  @@index([createdAt])
  @@index([type, createdAt])
  @@unique([contributorId, url])

  collectionResources CollectionResource[]
}

model Tag {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  resources Resource[]
}

model Collection {
  id          String   @id @default(cuid())
  title       String   @db.VarChar(120)
  description String?  @db.VarChar(500)
  isPrivate   Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  ownerId String?
  owner   User?   @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  resources CollectionResource[]

  @@index([ownerId, createdAt(sort: Desc), id(sort: Desc)])
}

model CollectionResource {
  collectionId String
  resourceId   String
  addedAt      DateTime @default(now())

  collection Collection @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  resource   Resource   @relation(fields: [resourceId], references: [id], onDelete: Cascade)

  @@id([collectionId, resourceId])
  @@index([collectionId, addedAt(sort: Desc), resourceId(sort: Desc)])
  @@index([resourceId])
}
```

### Naming conventions

- Model names: **PascalCase, singular** (`User`, not `users`)
- Field names: **camelCase** (`createdAt`, not `created_at`)
- Enum names: **PascalCase** (`UserRole`, not `USER_ROLE`)
- Enum _values_: **SCREAMING_SNAKE_CASE** (`RESEARCH_PAPER`)
- Directories and files are **plural** (`src/resources/resources.service.ts`)

### Identifiers

`User.id` **is** the Clerk user ID and has no default — there is no local ID
mapping. Every other model generates its own, so `Resource` uses
`@default(cuid())`. Resource is the first model here to do so; match it on new
models rather than matching `User`.

### The contributor relation

`Resource.contributorId` is **nullable** with `onDelete: SetNull`. This is
deliberate and load-bearing:

- `src/webhooks/webhooks.service.ts` handles Clerk's `user.deleted` event by
  hard-deleting the local `User` row. The default `Restrict` behaviour would
  raise a foreign key violation there, the webhook would return 400, and the
  user row would leak permanently.
- `SetNull` keeps a deleted contributor's resources intact and only drops the
  attribution, so reads must tolerate `contributor: null`.
- `Cascade` is ruled out: it would silently destroy curated content.

The alternative — a `deletedAt` column on `User` (soft delete) — was considered
and deferred. It preserves `contributorId` indefinitely, but every future `User`
query would then have to filter `deletedAt: null`, and the deleted user's PII
would be retained. Revisit if attribution-after-deletion ever becomes a
requirement. Note that once `SetNull` has nulled a row, the original Clerk ID
cannot be recovered.

### Indexing

A btree on the low-cardinality `type` enum alone is close to useless, so the
load-bearing ones are the composites. Index the queries you actually write, not
every column.

The `(type, createdAt)` index covers the list endpoint's `orderBy` prefix.
Pagination adds `id DESC` as a tiebreaker on top of that, so a cursor scan over
the full ordering is not covered by a single index — acceptable at current scale,
but if the list endpoint ever gets slow under load, the fix is a composite
`(type, createdAt, id)`.

`(contributorId, createdAt DESC, id DESC)` serves a profile's listing
(`?contributor=`). A plain `@@index([contributorId])` would find the right rows
and then sort all of them, so it is not enough on its own. The `id` tiebreaker is
in the index for the same reason it is in the ordering — `createdAt` is not
unique, and a cursor over a non-total order skips or repeats rows.

Note that a standalone `@@index([contributorId])` would also be **redundant**
against `@@unique([contributorId, url])`, which already covers the
duplicate-URL check's `{ contributorId, url }` predicate as a prefix.

### Listing and pagination

`GET /api/v1/resources` is keyset-paginated and returns an object, not an array:

```json
{
  "items": [
    /* ResourceResponseDto */
  ],
  "nextCursor": "Y2tpZGEyYjM0"
}
```

- `?limit=` defaults to 20 and is capped at 100.
- `?cursor=` takes the previous page's `nextCursor` verbatim. It is base64url of
  the last row's id — opaque so a client cannot hand-craft a position, and
  url-safe so it needs no escaping.
- Ordering is `createdAt DESC, id DESC`. The `id` tiebreaker is **load-bearing**:
  `createdAt` is not unique, and a cursor over a non-total order silently skips
  or repeats rows when several resources share a millisecond.
- `nextCursor` is `null` on the last page. It is computed by fetching
  `limit + 1` rows rather than running a `COUNT(*)`, so paging costs the same
  regardless of table size.
- An unknown or stale cursor returns an **empty page, not a 400**. That is
  deliberate: a resource can be deleted between a client reading a page and
  asking for the next, and an error toast there would be spurious.

Cursor decoding rejects anything outside a loose id allowlist rather than
pinning cuid's alphabet — a format-specific regex would silently break if the
id generator ever changed. Prisma parameterises the query, so the check is input
sanity, not an injection guard.

### Tags

`Resource.tags` is a Prisma **implicit** many-to-many, so Prisma owns the
`_ResourceToTag` join table. Both of its foreign keys cascade, which only
removes join rows — deleting a `Tag` never deletes the `Resource` pointing at
it, and vice versa.

An explicit join model is only worth it when you need metadata on the assignment
itself, and the _ordering_ counts: Prisma cannot `orderBy` an implicit
many-to-many, so a set that has a meaningful order has to be a row that can be
sorted. `CollectionResource` is that row. Tags have no such order — a resource
carries five of them, unordered — which is why `_ResourceToTag` stayed implicit.
See [Collections](#collections) below.

`Tag` keeps two identifiers on purpose:

- `name` is the **display form as typed** — `C++`, `Machine Learning`,
  `node.js`. Collapsing these into a single field would be lossy on a technical
  audience.
- `slug` is the **normalized identity** and the only unique one. Normalizing in
  `slugifyTag` (lowercase, spaces and disallowed runs to hyphens) collapses
  `"Machine Learning"` and `"machine-learning"` onto one tag for free, so the
  most common duplicate spelling cannot exist.

`slugifyTag` folds with **NFKD and strips combining marks** before applying the
allowlist. This matters: an ASCII-only allowlist silently ate the accents, so
`Café` became `caf` and `naïve` became `na-ve` — valid slugs, wrong data, no
error. It also folds full-width forms (`Ｆｕｌｌ` → `full`) and collapses
`Café`/`cafe`/`CAFÉ` onto one tag.

NFKD does **not** transliterate scripts with no Latin decomposition, so Cyrillic,
Greek and CJK normalize to nothing and are rejected. `isUnsupportedScript`
distinguishes that from ordinary punctuation so the error can say so honestly
("uses a script that cannot be turned into a tag URL yet") rather than telling
someone that `日本語` is not "2-40 letters". Adding transliteration is a
deliberate follow-up, not an oversight.

Because `#` is kept in the slug, `C#` does not collapse into `c` and collide
with the C language tag — but a `#` in a URL path segment starts the fragment,
so **tag URLs must be built with `encodeURIComponent`** (`/tags/c%23`).

`TagsService.normalizeTags` is where the policy lives: it rejects unnormalizable
names, caps the count, and dedupes by slug. `slugifyTag` itself stays pure and
never throws.

### Collections

`CollectionResource` is the first **explicit** join model in the schema, for the
reason given above: "in the order I collected them, newest first" is a property
of the assignment, and an implicit many-to-many has nowhere to put it.

Three decisions here are worth stating, because each one departs from what the
rest of the schema does.

**The owner cascades; the contributor is nulled.** `Collection.owner` uses
`onDelete: Cascade` where `Resource.contributor` uses `SetNull`, and that is not
an inconsistency. A contribution outlives its author because its `why` is still
worth reading and nobody can be named for it anyway. A collection has no content
of its own — only an arrangement of somebody else's — and with the account gone
there is no curator to be curated _by_. An ownerless collection could not be
listed by any route, so `SetNull` would strand rows rather than preserve
anything. Deleting your account deletes your collections, along with their join
rows, via two cascades.

**`isPrivate` defaults to `true`,** which is the opposite of `isProfilePrivate`
and `isAnonymous`. Those gate something already published; this gates something
that has not been. Collecting is a personal act, and publishing it should be a
separate decision rather than a side effect of making the list.

**Visibility is a boolean, not an enum.** Two states, and every other two-state
privacy control in the schema is a boolean too. Adding a third state later would
be the moment to reconsider, and it would be a migration.

#### The compound keyset cursor

`GET /api/v1/collections/:id/resources` is keyset-paginated like the resource
feed, over the **join table** rather than over `Resource`. Ordering by a
resource's own `createdAt` would be a different and wrong list: it reflects when
each resource was _shared_, not when it was _collected_.

That has one consequence worth knowing. `resourceId` is not unique on its own —
the same resource can sit in fifty collections — so Prisma refuses it as a
cursor. The primary key `(collectionId, resourceId)` is unique, so that is the
cursor target:

```ts
cursor: {
  collectionId_resourceId: { collectionId: id, resourceId: decodeCursor(cursor) },
},
skip: 1,
```

The opaque cursor still only carries a **resource id**. `collectionId` is
already in the path, so `src/pagination/cursor.util.ts` needed no change — it
was moved out of `resources/` for sharing but its format is identical for both
call sites. The index
`[collectionId, addedAt DESC, resourceId DESC]` serves it, with `resourceId` as
the tiebreaker for the same reason `id` is everywhere else: `addedAt` is not
unique.

`@@index([resourceId])` exists for the opposite direction — "which of this
resource's owner's collections already hold it" — which backs
`?resourceId=` on `GET /collections/me`. Without it that check is a sequential
scan of the whole join table.

#### Deleting

Both foreign keys cascade, so deleting a collection removes its join rows and
deleting a resource removes it from every collection it was in.

### Saved resources

`SavedResource(userId, resourceId, savedAt)` is the bookmark list — a resource
somebody saved with no grouping attached. It is a third explicit join model,
structurally identical to `CollectionResource` with the collection half replaced
by a user.

The composite primary key is what makes save and unsave idempotent without the
service reading first, and it is also the cursor target for `GET /saved`: the
cursor carries only `resourceId`, because `userId` is known from the session.

The list pages on `savedAt DESC, resourceId DESC`, not on the resource's own
`createdAt` — for a two-year-old contribution saved yesterday, `createdAt` would
sort the list into the wrong order entirely.

`@@index([resourceId])` backs the public `savedCount` on
`ResourceResponseDto.savedCount`, which is read far more often than any one
person's list.

Both FKs cascade, so deleting a user removes their bookmarks and deleting a
resource removes it from every saved list.

Deliberately **not** modelled as a system-owned "Saved" collection. A collection
is a curation with a reason for why its contents belong together; a bookmark has
no such claim. Folding them together would make `description` meaningless on the
one list everybody has, force every listing query to exclude it, and collide with
the cascade that removes a deleted user's collections.

See [saved.md](./saved.md). Neither touches
a resource. `TagsService.remove` refuses to delete a tag that still has
resources, and collections deliberately do **not** follow that precedent: that
guard exists because detaching a tag would rewrite contributions other people
wrote. A join row records only that this owner chose this resource for this
list, and deleting the list is the owner withdrawing their own arrangement. The
resources inside keep their own attribution and are untouched.

### Comments

`Comment(id, resourceId, authorId, parentId, body, createdAt)` is a remark on a
resource. Migration `20261001083312_add_comment_model`.

Three foreign keys, three different delete rules, each for a stated reason:

- `resourceId` **cascades.** A comment on a resource that no longer exists has no
  referent, and deleting a resource is a hard delete for everybody at once.
- `authorId` is **nullable and sets null**, like `Resource.contributor`. A comment
  is somebody's words and outlives its author for the same reason a contribution
  does; the response renders a null author as `[removed]`. Clerk deletes accounts on
  its own schedule, so this path really happens.
- `parentId` **sets null**, so deleting a comment drops the quote on its replies
  rather than cascading other people's words away.

`@@index([resourceId, createdAt(sort: Desc), id(sort: Desc)])` serves the listing
and, as a prefix, the public `commentCount` on `ResourceResponseDto` — which is why
there is no separate `@@index([resourceId])` here, unlike `SavedResource`.

`@@index([parentId])` exists because Postgres does not index the referencing side
of a foreign key. Without it, removing a parent comment scans the whole table.

Deliberately **not** a like/dislike pair, and deliberately **not** a reply tree. See
[comments.md](./comments.md).

### Granting ADMIN

`UserRole` has **no write path in the API** — no endpoint can change a role, so
promotion is not reachable over HTTP. That is deliberate, but it also means the
first admin has to be promoted out of band:

```bash
pnpm user:set-role <clerk-user-id> ADMIN   # or USER to demote
```

The script (`scripts/user-set-role.sh`) runs through `prisma db execute`, so it
needs no TypeScript runtime, and it validates the Clerk ID against
`^user_[A-Za-z0-9]+$` before it reaches the query. Note that `prisma db execute`
reports success even when no row matched, so confirm the change landed. Tags are created implicitly on resource write via
`createMany({ skipDuplicates: true })` — there is deliberately no
`POST /api/v1/tags`, so a tag can never exist without being attached to
something.

`GET /api/v1/tags?query=` backs the contributor typeahead, and an empty `query`
returns the most-used tags so browsing the whole vocabulary needs no second
route. It orders by usage count **in memory** rather than with a relation
`_count` orderBy, which is not something to rely on across Prisma versions; the
candidate set is capped at 20 regardless. The `contains`/`insensitive` filter is
not index-backed, which is fine while the vocabulary is small.

**Known follow-ups, deliberately not built yet:**

- **Tag merge.** Free-form tags mean `ml` and `machine-learning` can coexist.
  Nothing merges them today. A merge path (admin-only endpoint, or a manual SQL
  update) is required eventually, or the vocabulary degrades irreversibly.
- **Tag landing pages.** `GET /api/v1/tags/:name` does not exist yet. Nothing
  in the current read path depends on it.
- **Search indexing.** If the tag table grows enough for `contains` to matter, a
  GIN trigram index needs `pg_trgm`, which Prisma cannot express — it has to be
  hand-written into a migration. The same applies to full-text search over
  `Resource.title` and `Resource.why`.

### Schema changes

When modifying the schema:

1. Edit `prisma/schema.prisma`
2. Run `pnpm prisma migrate dev --name <description>` to create and apply a migration
3. Run `pnpm prisma generate` to regenerate the typed client

The generated client is output to `src/generated/prisma/` (gitignored). This directory is excluded from ESLint in `eslint.config.mjs`.

---

## Configuration (`prisma.config.ts`)

```ts
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '.env.local' });
config({ path: '.env' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
```

The config loads `.env.local` first, then `.env`, so local overrides take precedence. The `DATABASE_URL` is read from the environment and passed to Prisma.

---

## PrismaService (`src/prisma/prisma.service.ts`)

`PrismaService` extends `PrismaClient` and manages the connection lifecycle:

```ts
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(configService: ConfigService) {
    const adapter = new PrismaPg({
      connectionString: configService.getOrThrow<string>('DATABASE_URL'),
    });
    super({ adapter, errorFormat: 'pretty' });
  }

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

Key points:

- Uses `ConfigService` to read `DATABASE_URL` — consistent with the rest of the app
- Creates a `PrismaPg` adapter with the connection string passed directly (no `pg.Pool` wrapper)
- Connects on module init and disconnects on module destroy

## PrismaModule (`src/prisma/prisma.module.ts`)

`PrismaModule` is **global** (`@Global()`), so `PrismaService` is injectable in any module without importing `PrismaModule`:

```ts
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

---

## Common operations

### Querying

```ts
// Find all
const users = await this.prismaService.user.findMany();

// Find by ID
const user = await this.prismaService.user.findUnique({ where: { id } });

// Create
const user = await this.prismaService.user.create({
  data: { id, name, email },
});

// Update
const user = await this.prismaService.user.update({
  where: { id },
  data: { name },
});

// Delete
const user = await this.prismaService.user.delete({ where: { id } });
```

### Transactions

```ts
const [user, count] = await this.prismaService.$transaction([
  this.prismaService.user.create({ data }),
  this.prismaService.user.count(),
]);
```

---

## Migration workflow

```bash
# Create and apply a new migration. Non-interactive on a clean history.
pnpm prisma migrate dev --name add_profile_table

# Reset database (drops all data and re-applies all migrations)
# Takes --force, so it IS safe non-interactively.
pnpm prisma migrate reset --force

# Generate the client. NOT implied by the two commands above — see below.
pnpm prisma generate

# View migration status. Compares the migrations folder to the database, so it
# reports "up to date" even when schema.prisma has an un-migrated change.
pnpm prisma migrate status
```

**`migrate dev` does not run `prisma generate`.** Prisma 7 removed automatic
generation from `migrate dev`, `migrate reset` and `db push`; the `--skip-generate`
and `--skip-seed` flags were deleted with no replacement. Always generate
yourself.

This fails _silently_ when skipped. `src/generated/prisma/` is gitignored, so a
stale client is not a visible diff — `typecheck` and `test` keep passing against
the _previous_ schema's types, and a new column or enum simply does not exist.
Nothing fails until much later, and not with an error pointing here. Only
`pnpm install` (via `postinstall`) regenerates on its own.

To preview what Prisma would generate:

```bash
pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

This compares the **live database** against `schema.prisma`, so it needs a
reachable `DATABASE_URL` and shows only what is genuinely un-migrated. The older
`--to-schema-datamodel` flag was removed in Prisma 7 in favour of `--to-schema`.
`--from-migrations` is the offline alternative but requires
`datasource.shadowDatabaseUrl` to be set in `prisma.config.ts`.

## Seeds

There are no `prisma` seed hooks. Prisma 7 removed them, and there is no
`prisma.seed` key in `prisma.config.ts`. Anything that has to be seeded is a
deliberate `pnpm` script instead:

```bash
pnpm seed:reserved-usernames   # the reserved-username table
pnpm seed:resources            # a dev set of resources, tags and contributors
```

`seed:resources` is the one to reach for when you want something to look at: 19
fictional resources across eight `ResourceType`s, both access levels, two
contributors, one anonymously shared row, 36 tags, and dates spread over a month
so keyset pagination has something to page. Every row's id starts with `seed-`,
and the script **deletes only `seed-%` rows** before inserting, so re-running
refreshes the set instead of doubling it and can never touch a real contribution.

That delete is the difference from `seed:reserved-usernames`, which only ever
appends. `ON CONFLICT DO NOTHING` alone would leave yesterday's rows behind after
you edited the list.

A seeded contributor is an invented Clerk id (`seed-user-ada`) and can never be
signed in to, which is deliberate — a seed cannot collide with a real account,
and the resources are still attributed and browsable.

That seeds the reserved-username table. It **generates SQL and pipes it to
`prisma db execute`** rather than using the client, because the generated Prisma
client cannot be imported from a bare `ts-node` script — it `require`s its own
internals with a `.js` extension that only resolves under the Nest build, and
fails with `Cannot find module './internal/class.js'`. Same reason
`user-set-role.sh` is a shell script.

Idempotency for `seed:reserved-usernames` is `ON CONFLICT ("usernameLower") DO
NOTHING`, so re-running never overwrites a `RELEASED` row written by a username
change. Note the column list omits `createdAt`: the table has
`DEFAULT CURRENT_TIMESTAMP`, and naming the column would make Postgres expect a
third expression per row.

**Columns with no database default must be supplied by a raw seed.** Prisma
manages `id` (via `@default(cuid())`) and `updatedAt` (via `@updatedAt`) on the
application side, so neither has a `DEFAULT` in Postgres and a hand-written INSERT
that omits them leaves `NULL` against a `NOT NULL` column. `seed:resources`
supplies both explicitly for `Tag`; `createdAt` is genuinely defaulted and is
left out for the same reason as above.

**The `_ResourceToTag` join takes ids, not slugs.** Its foreign keys point at
`Resource(id)` and `Tag(id)`, so a seed that joins on the tag slug looks correct
and then fails on the constraint.

## Troubleshooting

### Generated client not found

If you see `Cannot find module '../generated/prisma/client'`, regenerate:

```bash
pnpm prisma generate
```

### Adapter errors

Ensure `DATABASE_URL` is set correctly in `.env`. The URL format is:

```text
postgresql://<user>:<password>@<host>:<port>/<database>
```

### CJS errors

If Prisma generates ESM output, check that `prisma/schema.prisma` has `moduleFormat = "cjs"` in the `generator client` block and re-run `pnpm prisma generate`.
