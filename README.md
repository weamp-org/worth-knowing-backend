# Worth Knowing Backend

NestJS 11 API for Worth Knowing, with Clerk authentication, Prisma ORM, role-based access control, and pre-commit lint-staged hooks.

## Features

- **Authentication** — Clerk-powered via `@clerk/express` with global middleware, configurable guards, and auto-provisioning of local user records on first sign-in
- **Authorization** — Role-based access control with `@Roles()` decorator and `RolesGuard` (`USER` / `ADMIN` roles)
- **Database** — Prisma v7 with PostgreSQL via `@prisma/adapter-pg`, auto-generated typed client, migration workflow
- **REST API** — Global `/api/v1` prefix, users CRUD scaffold, `ValidationPipe` with whitelist/transform (with implicit conversion)
- **Webhooks** — Clerk webhook handler for `user.created` / `user.updated` / `user.deleted` events with signature verification
- **Rate Limiting** — `@nestjs/throttler`, 100 requests/min per user
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

# 6. Start the development server
pnpm start:dev
```

The API is now available at `http://localhost:3000/api/v1`. Swagger docs at `http://localhost:3000/api/v1/documentation`.

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
│   ├── schema.prisma               # Database schema (User model, UserRole enum)
│   └── migrations/                 # Migration history
├── src/
│   ├── main.ts                     # Entry point (global prefix, Clerk, CORS, Swagger, ValidationPipe)
│   ├── app.module.ts               # Root module (imports all features)
│   ├── app.controller.ts           # Root controller (GET /api/v1 health)
│   ├── app.service.ts              # Root service
│   ├── clerk-auth/
│   │   └── clerk-auth.guard.ts     # Clerk authentication guard
│   ├── public/
│   │   └── public.decorator.ts     # @Public() — bypass auth on routes
│   ├── roles/
│   │   ├── roles.decorator.ts      # @Roles() — require specific roles
│   │   └── roles.guard.ts          # Roles authorization guard
│   ├── logging/
│   │   ├── pino.config.ts         # Pino configuration (structured JSON, redaction, serializers)
│   │   ├── logging.middleware.ts  # Request ID propagation to response header
│   │   └── routes.ts              # ALL_ROUTES wildcard shared by both middlewares
│   ├── filters/
│   │   └── global-exception.filter.ts # Global exception filter with Prisma error translation
│   ├── prisma/
│   │   ├── prisma.module.ts        # Global Prisma module
│   │   └── prisma.service.ts       # PrismaClient with adapter-pg
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.controller.ts     # /api/v1/users/me/settings (only)
│   │   ├── users.service.ts
│   │   └── dtos/
│   │       ├── update-my-settings.dto.ts
│   │       └── user-response.dto.ts
│   └── webhooks/
│       ├── webhooks.module.ts
│       ├── webhooks.controller.ts  # POST /api/v1/webhooks/clerk
│       └── webhooks.service.ts     # Clerk webhook event handlers
├── test/
│   ├── jest-e2e.json               # E2E Jest config
│   └── app.e2e-spec.ts
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

## API overview

All endpoints are prefixed with `/api/v1`.

| Method   | Path                  | Auth                   | Description           |
| -------- | --------------------- | ---------------------- | --------------------- |
| `GET`    | `/`                   | Public                 | Service health        |
| `GET`    | `/tags`               | Public                 | Search tags           |
| `GET`    | `/resources`          | Public                 | List resources        |
| `GET`    | `/resources/:id`      | Public                 | One resource          |
| `GET`    | `/resources/:id/mine` | Authenticated          | Did you contribute it |
| `POST`   | `/resources`          | Authenticated          | Share a resource      |
| `PATCH`  | `/resources/:id`      | Contributor or admin   | Update a resource     |
| `DELETE` | `/resources/:id`      | Contributor or admin   | Delete a resource     |
| `GET`    | `/users/me/settings`  | Authenticated          | Your own settings     |
| `PATCH`  | `/users/me/settings`  | Authenticated          | Update your settings  |
| `POST`   | `/webhooks/clerk`     | Public (skip throttle) | Clerk webhook events  |

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

## Auth model

Worth Knowing implements a layered auth strategy:

1. **Global middleware** — `clerkMiddleware()` from `@clerk/express` runs on every request, parsing the session JWT and attaching user identity to `req.auth`
2. **Guard layer** — `ClerkAuthGuard` on controllers rejects unauthenticated requests. It also **auto-provisions** a local `User` record on first sign-in: if the Clerk user ID isn't in your database, it fetches the user from the Clerk API and inserts them
3. **Bypass** — `@Public()` decorator skips the guard for public routes
4. **RBAC** — `@Roles(UserRole.ADMIN)` decorator combined with `RolesGuard` restricts endpoints to specific roles. `RolesGuard` checks `@Public()` first, then verifies the user's role from the local database

See [docs/auth.md](docs/auth.md) for a detailed walkthrough.

## Development

- **Add a new resource** — See [docs/new-resource.md](docs/new-resource.md) for a step-by-step guide
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
