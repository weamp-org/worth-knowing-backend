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

  @@index([contributorId])
  @@index([createdAt])
  @@index([type, createdAt])
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
