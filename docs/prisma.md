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
  id       String  @id
  name     String
  email    String  @unique
  imageUrl String?

  role UserRole @default(USER)

  resources Resource[]
}

model Resource {
  id         String       @id @default(cuid())
  title      String       @db.VarChar(200)
  url        String
  type       ResourceType
  accessType AccessType   @default(UNKNOWN)
  why        String
  createdAt  DateTime     @default(now())
  updatedAt  DateTime     @updatedAt

  contributorId String?
  contributor   User?   @relation(fields: [contributorId], references: [id], onDelete: SetNull)

  tags Tag[]

  @@index([contributorId])
  @@index([createdAt])
  @@index([type, createdAt])
}

model Tag {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  resources Resource[]
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

`Resource` carries three indexes. A btree on the low-cardinality `type` enum
alone is close to useless, so the load-bearing one is the composite with
`createdAt`, which serves "latest resources of type X". Index the queries you
actually write, not every column.

### Tags

`Resource.tags` is a Prisma **implicit** many-to-many, so Prisma owns the
`_ResourceToTag` join table. Both of its foreign keys cascade, which only
removes join rows — deleting a `Tag` never deletes the `Resource` pointing at
it, and vice versa. An explicit join model is only worth it if you need
metadata on the assignment itself (who tagged it, when), which moderation might
want later.

`Tag` keeps two identifiers on purpose:

- `name` is the **display form as typed** — `C++`, `Machine Learning`,
  `node.js`. Collapsing these into a single field would be lossy on a technical
  audience.
- `slug` is the **normalized identity** and the only unique one. Normalizing in
  `slugifyTag` (lowercase, spaces and disallowed runs to hyphens) collapses
  `"Machine Learning"` and `"machine-learning"` onto one tag for free, so the
  most common duplicate spelling cannot exist.

Because `#` is kept in the slug, `C#` does not collapse into `c` and collide
with the C language tag — but a `#` in a URL path segment starts the fragment,
so **tag URLs must be built with `encodeURIComponent`** (`/tags/c%23`).

`TagsService.normalizeTags` is where the policy lives: it rejects unnormalizable
names, caps the count, and dedupes by slug. `slugifyTag` itself stays pure and
never throws. Tags are created implicitly on resource write via
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
# Create and apply a new migration
pnpm prisma migrate dev --name add_profile_table

# Reset database (drops all data and re-applies all migrations)
pnpm prisma migrate reset

# Generate client after schema changes (also done by migrate dev)
pnpm prisma generate

# View migration status
pnpm prisma migrate status
```

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
