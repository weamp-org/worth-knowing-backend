# Authentication & Authorization

## Overview

Auth is built on [Clerk](https://clerk.com/) and uses a layered approach:

1. **Global Clerk middleware** — Parses session JWTs on every request
2. **`ClerkAuthGuard`** — Rejects unauthenticated requests at the controller level; auto-provisions local user records
3. **`@Public()` decorator** — Opts routes out of authentication
4. **`@Roles()` decorator + `RolesGuard`** — Restricts endpoints to specific user roles

---

## Layer 1 — Clerk middleware (global)

In `src/main.ts`, `clerkMiddleware()` from `@clerk/express` is applied globally:

```ts
app.use(clerkMiddleware());
```

This runs on every incoming request. It reads the session token from the `Authorization` header (or cookie), verifies it against Clerk, and attaches `auth` to the request object. If no valid token is present, `req.auth.userId` is `null`.

The middleware does **not** reject unauthenticated requests — it only parses whatever credentials are present. Rejection is handled by the guard layer.

---

## Layer 2 — `ClerkAuthGuard` (controller-level)

`ClerkAuthGuard` is applied to controllers (e.g. `@UseGuards(ClerkAuthGuard)` on `UsersController`).

### Guard logic (`src/clerk-auth/clerk-auth.guard.ts`)

```text
request → is @Public()? → yes → allow
       → no
       → get req.auth.userId from Clerk
       → userId is null? → deny (401)
       → user exists in local DB? → yes → allow
       → no → fetch user from Clerk API → create local User record → allow
```

**Auto-provisioning detail:** When a user authenticates for the first time, their Clerk user ID isn't in your database. The guard fetches the user from Clerk via `clerkClient.users.getUser(userId)`, extracts `fullName` (or `username`), `primaryEmailAddress`, and the profile `imageUrl`, and creates a local `User` record with role `USER`. Subsequent requests hit the database directly.

An error is thrown if the Clerk user record is missing an email address.

The guard is **create-only**: once a local record exists it is never updated from this path, and no Clerk API call is made at all. Keeping Clerk-owned fields current is the webhook's job (see `docs/webhooks.md`) — `user.updated` refreshes `name`, `email`, and `imageUrl` together.

`name`, `email` and `imageUrl` are **not writable through the REST API at all**. They are Clerk-owned, and the template's `POST /users` and `PATCH /users/:id` have been removed precisely because a local write would be reverted on the next Clerk event without warning. There is no user DTO that accepts them, so sending any of the three in a request body is rejected with a 400 by the global `ValidationPipe` (`forbidNonWhitelisted: true`). The two user-writable surfaces are `PATCH /users/me/settings` (`anonymousByDefault`) and `PATCH /users/me/profile` (username, bio, profile privacy) — see `docs/profiles.md`. Pre-existing rows are backfilled on the user's next `user.updated` event.

---

## Keeping Clerk-owned fields current

`ClerkAuthGuard` is **create-only**: it provisions a user on their first
authenticated request and never revisits them — `if (existingUser) return`.

That is deliberate. The guard runs on **every authenticated request**, so
refreshing `name` and `imageUrl` there would mean a Clerk API call per API call:
latency on everything, rate-limit exposure, and the app's availability coupled to
Clerk's. For a field that changes a handful of times in a user's life, that is a
bad trade.

So the responsibilities split:

| Concern                                | Owner                                |
| -------------------------------------- | ------------------------------------ |
| Create the row on first sight          | `ClerkAuthGuard`                     |
| Keep `name`/`email`/`imageUrl` current | `WebhooksService`, on `user.updated` |

**One writer per field**, and no Clerk call on the request path.

### The cost of that choice

There is exactly one writer, so if the webhook stops, updates stop — and it stops
_silently_. Every event fails signature verification, the endpoint 400s, and the
only symptom is a display name that quietly stopped changing. Two things narrow
that:

- `main.ts` warns at boot if `CLERK_WEBHOOK_SIGNING_SECRET` is missing or still
  the `.env.local.example` placeholder. It cannot detect a webhook URL that is
  unreachable from Clerk's servers — a tunnel being down is the other common
  cause, and is invisible from here — so this narrows the diagnosis rather than
  ruling it out.
- `pnpm user:sync <clerk-user-id>` repairs a user by hand: it fetches their
  current Clerk record and writes the three mirrored fields. Same shape as the
  existing `pnpm user:set-role`, and it warns if the Clerk record has no name at
  all, since that writes `null`.

### Why not a TTL refresh instead

The alternative to a webhook is storing `clerkSyncedAt` and refreshing when it is
stale. That removes the dependency but adds a column, a staleness rule, and
occasional Clerk calls, for a field that rarely changes. Not worth it yet.

---

## Layer 3 — `@Public()` decorator

Use `@Public()` to mark routes that should bypass authentication entirely:

```ts
@Get()
@Public()
findAll() {
  return this.usersService.findAll();
}
```

This sets metadata (`IS_PUBLIC_KEY = true`) that both `ClerkAuthGuard` and `RolesGuard` check before enforcing their rules.

---

## Layer 4 — Role-based access with `RolesGuard`

### The `@Roles()` decorator

Define required roles on a method:

```ts
@Delete(':id')
@Roles(UserRole.ADMIN)
remove(@Param('id') id: string) {
  return this.usersService.remove(id);
}
```

The `UserRole` enum is defined in `prisma/schema.prisma`:

```prisma
enum UserRole {
  USER
  ADMIN
}
```

### RolesGuard logic (`src/roles/roles.guard.ts`)

```text
request → is @Public()? → yes → allow
       → no
       → no roles required? → allow
       → get req.auth.userId
       → userId is null? → deny (403)
       → fetch user from DB
       → user not found? → deny (403)
       → user.role in required roles? → allow
       → deny (403)
```

The guard returns `403 Forbidden` rather than `401 Unauthorized` because the user is authenticated but lacks sufficient permissions.

---

## Usage guide

### On a new controller

```ts
import { Controller, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { RolesGuard } from '../roles/roles.guard';
import { Roles } from '../roles/roles.decorator';
import { Public } from '../public/public.decorator';
import { UserRole } from '../generated/prisma/enums';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('items')
export class ItemsController {
  // No `@ApiBearerAuth()` at the class level. A controller with a `@Public()`
  // route and a class-level bearer security documents every route as
  // authenticated, which is the mismatch the guards do not have. Annotate the
  // guarded methods individually instead — `UsersController` does this.
  @Get()
  @Public()
  @ApiOperation({ summary: 'List items' })
  findAll() {
    /* public */
  }

  @Post()
  @ApiBearerAuth()
  create() {
    /* any authenticated user */
  }

  @Delete(':id')
  @ApiBearerAuth()
  @Roles(UserRole.ADMIN)
  remove() {
    /* admin only */
  }
}
```

### Reading the session on a public route

A `@Public()` route skips `ClerkAuthGuard`, but Clerk's global middleware has
still parsed the session, so `getAuth(request).userId` is available and is
sometimes needed — `GET /users/:username` uses it to let an owner see their own
private profile. This only works because `clerkMiddleware()` runs globally in
`main.ts`:

```ts
@Get(':username')
@Public()
findByUsername(@Param('username') username: string, @Req() request: Request) {
  return this.usersService.findByUsername(username, getAuth(request).userId ?? undefined);
}
```

The same reason applies to the e2e specs: `getAuth` is mocked with an
`x-test-user-id` header standing in for the session.

### Registration

Since `ClerkAuthGuard` is provided globally in `AppModule`, you only need to add Guards and Decorators to your controllers. There is no need to register them per-module.

---

## Guard order matters

When both guards are used together, apply `ClerkAuthGuard` first, then `RolesGuard`:

```ts
@UseGuards(ClerkAuthGuard, RolesGuard)
```

This ensures `RolesGuard` runs after authentication so it can rely on `req.auth.userId` being populated.
