# Contributing

Thanks for your interest in contributing to Worth Knowing (backend).

## Prerequisites

- Node 24+, pnpm 11.2.2, Docker (for local PostgreSQL)
- A [Clerk](https://clerk.com) application

## Setup

```bash
pnpm install

# Docker Compose reads the Postgres password from this file (gitignored)
cp secrets/postgres_password.txt.example secrets/postgres_password.txt
# Edit secrets/postgres_password.txt with your desired PostgreSQL password

cp .env.local.example .env.local
# Edit .env.local with your Clerk keys and ensure DATABASE_URL uses the same
# password as secrets/postgres_password.txt. Keep the raw password in the
# Compose secret file; percent-encode it in DATABASE_URL if it contains
# URI-reserved characters (e.g. @, #, /, %).

docker compose up -d
pnpm prisma migrate dev
pnpm start:dev
```

## Commands

| Command                                    | Description                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm start:dev`                           | Dev server on port 3000                                                           |
| `pnpm build`                               | Compile to `dist/`                                                                |
| `pnpm lint`                                | ESLint (typescript-eslint + prettier)                                             |
| `pnpm format`                              | Prettier write                                                                    |
| `pnpm format:check`                        | Prettier check                                                                    |
| `pnpm typecheck`                           | `tsc --noEmit`                                                                    |
| `pnpm test`                                | Jest unit tests (`*.spec.ts`)                                                     |
| `pnpm test:e2e`                            | Supertest e2e tests                                                               |
| `pnpm user:set-role <clerk-user-id> ADMIN` | Promote/demote a local user (see [docs/prisma.md](docs/prisma.md#granting-admin)) |

Run `pnpm typecheck && pnpm lint && pnpm test` before submitting changes.

## Branching and commits

**During initial development, commit and push straight to `develop`.** No feature
branch, no PR. This is deliberate: the project has no external contributors yet
and nothing else depends on `develop`, so a branch costs a merge, a round trip
and a decision about whether to split the commits — in exchange for review
that nobody is doing.

Branch and open a PR when any of these become true:

- There are other contributors whose work must not land unreviewed
- CI is gated on a protected branch
- A change is large enough to want review before it lands

`main` is for releases and stays untouched by day-to-day work.

Commits should still be small and single-concern, and should still pass CI. The
simplification is about _where_ they land, not about what goes in them — a
feature and a refactor stay separate commits even when both go straight to
`develop`.

Both repositories are versioned independently, so a change spanning them is two
commits and two pushes, with no expectation of atomicity.

## Guidelines

- For schema changes, include the generated Prisma migration
- If adding an env var, update `.env.local.example` and document it in the README

See [docs/](docs/) for detailed guides on auth, testing, Prisma, webhooks, deployment, and adding new resources.
