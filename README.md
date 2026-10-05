# Worth Knowing Backend

NestJS 11 API for Worth Knowing, with Clerk authentication, Prisma ORM, role-based access control, and pre-commit lint-staged hooks.

## Features

- **Authentication** — Clerk-powered via `@clerk/express` with global middleware, configurable guards, and auto-provisioning of local user records on first sign-in
- **Authorization** — Role-based access control with `@Roles()` decorator and `RolesGuard` (`USER` / `ADMIN` roles)
- **Database** — Prisma v7 with PostgreSQL via `@prisma/adapter-pg`, auto-generated typed client, migration workflow
- **Resources** — Share a specific resource with a `why`, plus free-form tags, anonymous sharing, and keyset-paginated browsing
- **Collections** — Gather resources into a titled, optionally described list; private by default, curated from anything on the site
- **Saved resources** — Bookmark any resource in one click, independent of collections; a public save count on every resource response
- **Comments** — A flat, chronological thread per resource with one level of reply; public to read, authored and removable by its author or an admin
- **Reporting** — Any signed-in reader can flag a resource or a comment; the queues at `/resource-reports` and `/comment-reports` are admin-only and never name reporters

### Comments

Discussion on a resource, under `/resources/:id`. One flat list per resource, newest
first, with replies stored flat and rendered as a quote above the reply.

**Deliberately no like and no dislike.** There is no ranking on this site for a vote
to act on — the feed is chronological and sort-by-saved is refused on purpose — so a
downvote would have no mechanical function and would only punish people for sharing
what they found worth knowing. The job a downvote actually does, flagging something
for removal, is `POST .../:id/report`.

Replies are **one level and stored flat**: a real tree needs a cursor carrying a
materialised path, which would mean rewriting the keyset primitive every list here
depends on. A comment **outlives its author** (`authorId` is nullable and sets null),
so a deleted account's remarks stay and read as removed rather than anonymous.

Reporting works on both a **contribution** and a **comment**, and a contribution is the
higher-leverage of the two: a bad comment is one person's remark under one page, while a
bad link gets shared onward to people who never saw the flag. Both are idempotent,
neither can be filed on your own, and neither is **visible to anybody but a moderator**
— including the author. The queues are admin-only and one row per report; reporters are
never named, and an anonymously shared contribution is still redacted in the queue.

There is **no automatic hiding at N reports** and no karma. Auto-hide lets a pile-on
make a comment disappear with no human deciding.

See [docs/comments.md](docs/comments.md).

### Saved resources

A bookmark with no grouping attached — one click, and the resource lands on
`/saved`. **Deliberately not a system-owned "Saved" collection**: a collection is a
curation with a reason for why its contents belong together, and a bookmark has
no such claim, so folding them together would make `description` vacuous on the
one list everybody has.

Saving and collecting are **independent**. Saving something and later filing it in
a collection leaves both intact, because the bookmark is sometimes the only copy
somebody has. See [docs/saved.md](docs/saved.md).

Every route under `/saved` requires a session — a bookmark list is the most
private thing a person has here, and unlike a resource or a profile there is no
public version of it. `savedCount`, by contrast, is public and sits on every
resource response; it is a signal of _interest_, not of quality.

There is deliberately **no sort-by-saved and no "most saved" rail**. Paging by an
aggregate whose value changes while you page through it is genuinely hard, and
ranking the whole feed by saves would bury the newest contribution the moment
anybody saves anything. Sorting belongs on a filtered view, opt-in — see
[docs/saved.md](docs/saved.md).

- **Saved resources** — Bookmark any resource in one click, independent of collections; a public save count on every resource response
- **REST API** — Global `/api/v1` prefix, users CRUD scaffold, `ValidationPipe` with whitelist/transform (with implicit conversion)
- **Webhooks** — Clerk webhook handler for `user.created` / `user.updated` / `user.deleted` events with signature verification
- **Rate Limiting** — `@nestjs/throttler`, 100 requests/min per user, tightened to 10/hour on comment creation and both kinds of report
- **Logging** — Structured JSON logging with `nestjs-pino`, request/response auto-logging, request ID propagation, sensitive header redaction, and a global exception filter
- **Documentation** — Swagger UI at `/api/v1/documentation` (dev only), auto-generated from decorators and JSDoc
- **Testing** — Jest unit tests (with mocked Prisma) and Supertest e2e tests
- **Git hooks** — Husky + lint-staged pre-commit hook (auto-installed on `pnpm install`)
- **Tooling** — ESLint flat config (typescript-eslint + prettier), Docker Compose for local PostgreSQL

## Prerequisites

- [Node.js](https://nodejs.org/) 24+
- [pnpm](https://pnpm.io/) 11.2.2 (`npm install -g pnpm@11.2.2`)
- [Docker](https://www.docker.com/) (for local PostgreSQL)
- A [Clerk](https://clerk.com/) application (for authentication)

## Quick start

```bash
# 1. Install dependencies
pnpm install

# 2. Set up Docker secrets
cp secrets/postgres_password.txt.example secrets/postgres_password.txt
# Edit secrets/postgres_password.txt with your desired PostgreSQL password

# 3. Configure environment variables
cp .env.local.example .env.local
# Edit .env.local with your Clerk keys from https://dashboard.clerk.com and
# ensure DATABASE_URL matches the password set in step 2

# 4. Start PostgreSQL via Docker
docker compose up -d

# 5. Run database migrations
pnpm prisma migrate dev

# 6. Optional: seed some resources so the feed has something in it
pnpm seed:resources

# 7. Start the development server
pnpm start:dev
```

The API is now available at `http://localhost:3000/api/v1`. Swagger docs at `http://localhost:3000/api/v1/documentation`.

`pnpm seed:resources` gives you 19 fictional resources with tags, spread over a
month so pagination is worth testing. It deletes and re-inserts only rows whose
id starts with `seed-`, so re-running it is safe and never touches a real
contribution.

## Docker setup

The project uses [Docker Compose](compose.yaml) to run PostgreSQL with [Docker secrets](https://docs.docker.com/compose/use-secrets/) for secure credential management.

```yaml
# compose.yaml (relevant excerpt)
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_DB: worth_knowing
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    secrets:
      - postgres_password

secrets:
  postgres_password:
    file: ./secrets/postgres_password.txt
```

### Secrets

| File                                    | Purpose                                 |
| --------------------------------------- | --------------------------------------- |
| `secrets/postgres_password.txt`         | Actual PostgreSQL password (gitignored) |
| `secrets/postgres_password.txt.example` | Example with a placeholder value        |

1. Copy the example to create your secret file: `cp secrets/postgres_password.txt.example secrets/postgres_password.txt`
2. Edit the password to your desired value
3. Ensure the `DATABASE_URL` in `.env.local` uses the same password — e.g. `postgresql://postgres:your-password-here@localhost:5432/worth_knowing`

> **Note:** The `secrets/` directory is gitignored. Only the `*.example` file is tracked in version control.

### Existing Postgres volumes

`POSTGRES_DB` is only applied when the data volume is first initialized. If you previously ran Compose with a different database name (for example `nestjs-template`), renaming to `worth_knowing` does not migrate that data automatically, and `pg_isready` can still succeed even when the new database is missing.

For a clean local reset (destroys local DB data):

```bash
docker compose down -v
docker compose up -d
pnpm prisma migrate dev
```

To keep existing data instead, create or rename the database inside the running Postgres container so it matches `DATABASE_URL`, then point `.env.local` at that name.

## Project structure

```text
worth-knowing-backend/
├── compose.yaml                    # Docker Compose (PostgreSQL 18)
├── prisma.config.ts                # Prisma config (dotenv + defineConfig)
├── prisma/
│   ├── schema.prisma               # Database schema (User, Resource, Tag, Collection)
│   └── migrations/                 # Migration history
├── src/
│   ├── main.ts                     # Entry point (global prefix, Clerk, CORS, Swagger, ValidationPipe)
│   ├── app.module.ts               # Root module (imports all features)
│   ├── app.controller.ts           # Root controller (GET /api/v1 health)
│   ├── app.service.ts              # Root service
│   ├── validation.ts               # Shared ValidationPipe options
│   ├── clerk-auth/
│   │   ├── clerk-auth.guard.ts     # Clerk authentication guard
│   │   └── current-user.decorator.ts # @CurrentUserId()
│   ├── public/
│   │   └── public.decorator.ts     # @Public() — bypass auth on routes
│   ├── roles/
│   │   ├── roles.decorator.ts      # @Roles() — require specific roles
│   │   └── roles.guard.ts          # Roles authorization guard
│   ├── pagination/
│   │   └── cursor.util.ts          # Opaque keyset cursor encode/decode
│   ├── logging/
│   │   ├── pino.config.ts          # Pino configuration (structured JSON, redaction, serializers)
│   │   ├── logging.middleware.ts   # Request ID propagation to response header
│   │   └── routes.ts               # ALL_ROUTES wildcard shared by both middlewares
│   ├── filters/
│   │   └── global-exception.filter.ts # Global exception filter with Prisma error translation
│   ├── prisma/
│   │   ├── prisma.module.ts        # Global Prisma module
│   │   └── prisma.service.ts       # PrismaClient with adapter-pg
│   ├── resources/
│   │   ├── resources.module.ts
│   │   ├── resources.controller.ts      # /api/v1/resources
│   │   ├── resource-reports.controller.ts # /api/v1/resource-reports (admin only)
│   │   ├── resources.service.ts
│   │   ├── resource-read.ts        # Shared read shape, redaction, profilePath
│   │   ├── report-read.ts           # Queue read shape, report count, redaction
│   │   └── dtos/
│   ├── tags/
│   │   ├── tags.module.ts
│   │   ├── tags.controller.ts      # /api/v1/tags
│   │   ├── tags.service.ts
│   │   ├── slugify.util.ts
│   │   └── dtos/
│   ├── collections/
│   │   ├── collections.module.ts
│   │   ├── collections.controller.ts # /api/v1/collections
│   │   ├── collections.service.ts
│   │   └── dtos/
│   ├── saved/
│   │   ├── saved.module.ts
│   │   ├── saved.controller.ts     # /api/v1/saved (all authenticated)
│   │   ├── saved.service.ts
│   │   └── dtos/
│   ├── comments/
│   │   ├── comments.module.ts
│   │   ├── comments.controller.ts       # /api/v1/resources/:resourceId/comments
│   │   ├── comment-reports.controller.ts # /api/v1/comment-reports (admin only)
│   │   ├── comments.service.ts
│   │   ├── comment-read.ts         # Read shape, isMine, quote truncation
│   │   └── dtos/
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.controller.ts     # /api/v1/users/me/* and /api/v1/users/:username
│   │   ├── users.service.ts
│   │   ├── username.util.ts
│   │   ├── display-name.util.ts    # Display name, profilePath resolution
│   │   └── dtos/
│   └── webhooks/
│       ├── webhooks.module.ts
│       ├── webhooks.controller.ts  # POST /api/v1/webhooks/clerk
│       └── webhooks.service.ts     # Clerk webhook event handlers
├── test/
│   ├── jest-e2e.json               # E2E Jest config
│   └── *.e2e-spec.ts
├── .husky/                         # Git hooks (created on pnpm install)
└── secrets/                        # Docker secrets (gitignored, see secrets/*.txt.example)
```

## Configuration

The project uses two env files loaded in order: `.env.local` (local overrides, gitignored) then `.env` (shared defaults, gitignored). Copy the example file to get started:

| Variable                       | Required | Default                 | Description                                                                                       |
| ------------------------------ | -------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                 | Yes      | —                       | PostgreSQL connection string (e.g. `postgresql://postgres:postgres@localhost:5432/worth_knowing`) |
| `CLERK_PUBLISHABLE_KEY`        | Yes      | —                       | Clerk publishable API key                                                                         |
| `CLERK_SECRET_KEY`             | Yes      | —                       | Clerk secret API key                                                                              |
| `CLERK_WEBHOOK_SIGNING_SECRET` | No       | —                       | Clerk webhook signing secret (required for webhook verification)                                  |
| `FRONTEND_BASE_URL`            | No       | `http://localhost:3001` | Allowed CORS origin                                                                               |
| `PORT`                         | No       | `3000`                  | Application port                                                                                  |

## Scripts

| Command                   | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `pnpm install`            | Install all dependencies                             |
| `pnpm start:dev`          | Start dev server with file watching                  |
| `pnpm start:debug`        | Start dev server in debug mode                       |
| `pnpm start:prod`         | Run compiled production build (`node dist/src/main`) |
| `pnpm build`              | Compile to `dist/` (`deleteOutDir: true`)            |
| `pnpm lint`               | Run ESLint on source and test files                  |
| `pnpm format`             | Format source files with Prettier                    |
| `pnpm format:check`       | Check formatting (CI use)                            |
| `pnpm typecheck`          | Run `tsc --noEmit` for type errors                   |
| `pnpm test`               | Run unit tests (Jest, `*.spec.ts`)                   |
| `pnpm test:e2e`           | Run e2e tests (Jest, `*.e2e-spec.ts`)                |
| `pnpm test:cov`           | Run unit tests with coverage                         |
| `pnpm prisma generate`    | Regenerate Prisma client after schema changes        |
| `pnpm prisma migrate dev` | Create and apply a new migration                     |
| `pnpm seed:resources`     | Seed a dev set of resources, tags and contributors   |

## API overview

All endpoints are prefixed with `/api/v1`.

| Method   | Path                                     | Auth                   | Description                                                              |
| -------- | ---------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `GET`    | `/`                                      | Public                 | Service health                                                           |
| `GET`    | `/tags`                                  | Public                 | Search tags                                                              |
| `PATCH`  | `/tags/:id`                              | Admin only             | Rename a tag                                                             |
| `DELETE` | `/tags/:id`                              | Admin only             | Delete an unused tag                                                     |
| `GET`    | `/resources`                             | Public                 | List resources; `?q=` searches, `?sort=` orders; returns `facets` counts |
| `GET`    | `/resources/:id`                         | Public                 | One resource                                                             |
| `GET`    | `/resources/:id/mine`                    | Authenticated          | Did you contribute it                                                    |
| `POST`   | `/resources`                             | Authenticated          | Share a resource (409 if you already shared that link)                   |
| `PATCH`  | `/resources/:id`                         | Contributor or admin   | Update a resource                                                        |
| `DELETE` | `/resources/:id`                         | Contributor or admin   | Delete a resource                                                        |
| `GET`    | `/saved`                                 | Authenticated          | Your own saved resources, newest saved first                             |
| `GET`    | `/saved/:resourceId`                     | Authenticated          | Did you save this resource                                               |
| `POST`   | `/saved`                                 | Authenticated          | Save a resource (idempotent)                                             |
| `DELETE` | `/saved/:resourceId`                     | Authenticated          | Remove a resource from your saved list                                   |
| `GET`    | `/collections/me`                        | Authenticated          | Your own collections                                                     |
| `GET`    | `/collections/:id`                       | Public                 | One collection (404 if private and not yours)                            |
| `GET`    | `/collections/:id/resources`             | Public                 | A collection's contents, newest collected first                          |
| `POST`   | `/collections`                           | Authenticated          | Create a collection (private unless you say otherwise)                   |
| `PATCH`  | `/collections/:id`                       | Owner or admin         | Update a collection                                                      |
| `DELETE` | `/collections/:id`                       | Owner or admin         | Delete a collection                                                      |
| `POST`   | `/collections/:id/resources`             | Owner                  | Add a resource (idempotent)                                              |
| `DELETE` | `/collections/:id/resources/:resourceId` | Owner                  | Remove a resource from a collection                                      |
| `GET`    | `/users/me/settings`                     | Authenticated          | Your own settings                                                        |
| `GET`    | `/users/me/profile`                      | Authenticated          | Your own profile                                                         |
| `PATCH`  | `/users/me/profile`                      | Authenticated          | Update your profile                                                      |
| `GET`    | `/users/:username`                       | Public                 | Somebody's public profile                                                |
| `POST`   | `/webhooks/clerk`                        | Public (skip throttle) | Clerk webhook events                                                     |

The template's `POST /users`, `GET /users`, `GET /users/:id`, `PATCH
/users/:id` and `DELETE /users/:id` were all removed.

- Users are provisioned automatically by `ClerkAuthGuard`, so `POST /users`
  had nobody to serve.
- `name`, `email` and `imageUrl` are owned by Clerk — `WebhooksService`
  overwrites all three on every Clerk event, so a local write would silently
  revert. `GET /users` also returned every signed-in caller a list of
  everyone's email addresses.
- `DELETE /users/:id` is intentionally absent. It is unreachable from the
  product and un-undoable: deleting a user sets `contributorId` to NULL on
  every resource they contributed, permanently dropping their name from all of
  it. Moderation should be designed with the reporting and reputation model it
  needs, not inherited as a raw endpoint.

`UserRole.ADMIN` is still meaningful — it widens `PATCH` and `DELETE` on a
resource from its contributor to any resource — so `pnpm user:set-role` still
has a purpose. See the note on `UsersController`.

### Tags

Contributors never write tags directly. There is no `POST /tags`: a tag is
created implicitly by `ensureTags` when a resource is written with it, so a tag
can never exist unattached to something. `MAX_TAGS_PER_RESOURCE` is 5.

`PATCH /tags/:id` renames the **display form only**. The `slug` is the tag's
identity and it is what appears in `/?tag=<slug>` URLs, which other people link
to; changing it would break every one of them, and a tag knows only the single
name it was created under, so there is nothing to redirect from. `UpdateTagDto`
has no `slug` property, and because the global `ValidationPipe` runs with
`forbidNonWhitelisted`, a client that tries to set one gets a 400 rather than
silently rewriting links.

`DELETE /tags/:id` **refuses with a 409 while the tag is still attached to any
resource**, and says to detach it with `PATCH /resources/:id` first. Cascading
instead would let one call strip a tag from contributions by other people, which
is the same un-undoable bulk damage that keeps `DELETE /users/:id` from
existing. Two steps keeps every destructive change attributable to a single
resource.

This is also the only way a tag can ever disappear. Tags are created implicitly
and nothing sweeps them, so a tag orphaned by a deleted resource stays in the
vocabulary forever. That is the reason the route exists.

### Duplicate links

A contributor cannot post the same link twice. `@@unique([contributorId, url])`
enforces it, and `ResourcesService` reads first so the failure is a 409 with a
sentence to act on rather than a P2002. The index is what decides: the service
also catches P2002 on both create and update, so a double-submitted form that
passes the read and loses the race still comes out as the same 409 instead of a 500.

**The check is per contributor, deliberately.** Two people independently finding
the same resource worth knowing is the product working — each brings a different
`why`, and that reasoning is the value. Deduplicating globally would discard one
person's actual contribution, and any boundary drawn on "same resource" would be
arbitrary the moment two URLs pointed at one book. Only the author repeating
themselves is noise, and rejecting that costs nobody else anything.

`PATCH /resources/:id` is checked the same way, against the _contributor's_
other resources and excluding the one being edited, so re-saving a resource
without touching its URL is never a conflict. An admin editing somebody else's
resource is still checked against that contributor's rows, since the index is on
`(contributorId, url)` and moving a contribution onto a link its own author
already used is the collision that matters.

`contributorId` is nullable and Postgres does not treat NULLs as conflicting in a
unique index, so rows belonging to a deleted contributor never block one
another — correct, since nobody can edit them.

### Who may change a resource

`PATCH /resources/:id` and `DELETE /resources/:id` both admit **the
contributor or an admin**, and the check lives in `ResourcesService`, not
behind `@Roles` on the controller.

That placement is forced rather than stylistic. `RolesGuard` short-circuits
with `if (!requiredRoles) return true`, so a route that declares no `@Roles`
gets no role lookup at all. A rule admitting either an owner or an admin
cannot be expressed with that decorator, so nothing would ever ask what role
the caller has — the service has to.

A contributor being able to delete their own contribution is deliberate: it is
the only self-service correction the product offers. There is no separate
"un-attribute" route, because `isAnonymous` already hides the name _and_ keeps
the resource editable — detaching the contributor outright would only take away
the author's ability to fix a typo or un-share.

### Collections

A collection is a titled, optionally described gathering of resources somebody
chose to keep together. The owner is usually saving links _other people_ shared,
and each resource keeps its own contributor's byline — which is why the relation
is `owner`, not `contributor`.

They are **private by default**. That is the opposite of `isProfilePrivate` and
`isAnonymous`, and deliberately so: those gate something already published, while
this gates something that has not been. Collecting is a personal act, and
publishing it should be a separate decision rather than a side effect of making
the list. A private collection is a **404 for anyone but its owner** — never a
403, which would confirm it exists.

An **optional description**, because a public collection without one is a titled
list of other people's links with no reasoning attached, and reasoning is the
whole product. It is where the curator's reason for the _grouping_ lives, the
same judgment as a resource's `why` one level up.

Three things that are not obvious from the routes:

- **Making a collection public does not deanonymize anything inside it.** The
  contents go through the same redaction as any public resource read, via
  `resources/resource-read.ts`, which is why that file is shared rather than
  copied. Worth knowing: it does give an anonymous resource a second stable
  URL.
- **Editing a collection admits an admin; curating one does not.** `PATCH` and
  `DELETE` are owner-or-admin because a public collection is public content.
  Adding a resource to somebody's list is owner-only — there is no content
  reason for an admin to arrange somebody's reading list.
- **Any resource can be collected, not only your own.** A collection of only
  your own posts would be a worse version of your profile page.

Contents are keyset-paginated over `CollectionResource` ordered by `addedAt`,
not over `Resource` by its own `createdAt` — a collection needs the order things
were _collected_, not the order they were _shared_. That needs a compound cursor,
because `resourceId` alone is not unique. See
[docs/collections.md](docs/collections.md) for the full walkthrough.

## Auth model

Worth Knowing implements a layered auth strategy:

1. **Global middleware** — `clerkMiddleware()` from `@clerk/express` runs on every request, parsing the session JWT and attaching user identity to `req.auth`
2. **Guard layer** — `ClerkAuthGuard` on controllers rejects unauthenticated requests. It also **auto-provisions** a local `User` record on first sign-in: if the Clerk user ID isn't in your database, it fetches the user from the Clerk API and inserts them
3. **Bypass** — `@Public()` decorator skips the guard for public routes
4. **RBAC** — `@Roles(UserRole.ADMIN)` decorator combined with `RolesGuard` restricts endpoints to specific roles. `RolesGuard` checks `@Public()` first, then verifies the user's role from the local database

See [docs/auth.md](docs/auth.md) for a detailed walkthrough.

## Development

- **Add a new resource** — See [docs/new-resource.md](docs/new-resource.md) for a step-by-step guide
- **Collections** — See [docs/collections.md](docs/collections.md) for the API, the visibility rules, and why the anonymity redaction is shared
- **Saved resources** — See [docs/saved.md](docs/saved.md) for the bookmark list, why it is not a collection, and why there is no sort-by-saved
- **Database changes** — Edit `prisma/schema.prisma`, run `pnpm prisma migrate dev`, then `pnpm prisma generate`
- **Testing** — See [docs/testing.md](docs/testing.md) for patterns and conventions
- **Logging** — See [docs/logging.md](docs/logging.md) for the middleware route pattern, `originalUrl` vs `req.url`, and known limitations

## Deployment

1. Set `NODE_ENV=production`
2. Ensure all required environment variables are set
3. Run `pnpm build` to compile to `dist/`
4. Start with `pnpm start:prod`

See [docs/deployment.md](docs/deployment.md) for a full checklist.

## License

[MIT](LICENSE)
