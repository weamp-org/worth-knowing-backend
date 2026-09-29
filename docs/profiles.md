# Profiles

A contributor's public face: a handle, a name, an avatar, a bio, and a privacy
switch. This document covers what the API exposes, what belongs to Clerk, and the
two mechanisms that are easy to confuse with each other.

---

## Who owns which field

| Field           | Owned by     | Edited through            | Stored locally as           |
| --------------- | ------------ | ------------------------- | --------------------------- |
| Display name    | Clerk        | Clerk's profile UI        | `name` (nullable)           |
| Avatar          | Clerk        | Clerk's profile UI        | `imageUrl`                  |
| Email           | Clerk        | Clerk's account settings  | `email`                     |
| Username        | **This app** | `PATCH /users/me/profile` | `username`, `usernameLower` |
| Bio             | This app     | `PATCH /users/me/profile` | `bio`                       |
| Profile privacy | **This app** | `PATCH /users/me/profile` | `isProfilePrivate`          |

The first three are mirrored, not owned. `WebhooksService` rewrites all three on
every Clerk event, so a local write would be reverted without warning — which is
why the template's `PATCH /users/:id` was removed and no DTO accepts them. See
`docs/auth.md`.

A username is deliberately **not** one of them. It is a product identity, not an
account identity: it needs a character set, a length bound, a list of words we
will not issue, and held history. Clerk's own username field enforces none of
those, and resolving a profile through Clerk would put an API call on the request
path of a public page.

### `name` is null, never "Anonymous"

`User.name` is nullable, and the webhook stores `null` when a Clerk user has set
no name.

It used to store the literal string `'Anonymous'`, in **two** places —
`ClerkAuthGuard` and `WebhooksService` — which was wrong three ways:

- **It collided with the product's own vocabulary.** A byline reading "Shared by
  Anonymous" sits right next to one reading "Shared anonymously", and those mean
  entirely different things. A user genuinely called Anonymous was
  indistinguishable from the fallback.
- **It fabricated an identity and stored it.** This codebase is otherwise careful
  not to make false claims about people — `isAnonymous` is a deliberate
  per-contribution choice, a private profile answers 404 rather than 403 so it
  does not leak that it exists, and a deleted contributor gets their own distinct
  wording rather than being called anonymous. Storing "Anonymous" as somebody's
  name undoes all three at once.
- **The two copies could drift**, so whether a user was provisioned with one name
  by the guard or a different one by a later webhook was a matter of timing.

Display name is resolved **on read** by `display-name.util.ts`: the Clerk name
first, then the handle claimed here. The `/share` gate guarantees anybody who can
appear in a byline has a handle, so the fallback always resolves, and `null` is
only reachable for an account with no contributions at all.

**Blank counts as absent, not just `null`.** Clerk returns `""` for a field that
is present but empty, and `??` alone would store that as a name — rendering a
byline reading "Shared by ". `firstPresent` trims and rejects empties.

---

## Endpoints

```text
GET   /api/v1/users/:username      @Public()   → ProfileResponseDto
GET   /api/v1/users/me/profile                  → ProfileResponseDto
PATCH /api/v1/users/me/profile                  → ProfileResponseDto
GET   /api/v1/resources?contributor=<username>  → PaginatedResourcesResponseDto
```

`GET /users/:username` is declared **after** the `me/*` routes on purpose. Nest
matches routes in declaration order, so a `:username` segment declared first
would shadow them.

### `ProfileResponseDto`

`username`, `usernameLower`, `name`, `imageUrl`, `bio`, `createdAt`,
`isProfilePrivate`, `resourcesCount`.

**No email, no role, no Clerk user id.** This is a fixed `select` in
`UsersService`, not a list of fields stripped from a full row — so a column added
to the `User` model cannot leak through by accident; the query has to name it.

This reverses the deliberate removal of `UserResponseDto`, which existed to hand
every signed-in caller a list of everyone's email addresses. The reasoning is
recorded in `dtos/profile-response.dto.ts`; the short version is that a public
profile and a user record are different contracts.

`resourcesCount` counts only contributions that carry a name. Counting anonymous
ones would disclose that they exist, and the number could be reconciled by
nobody but the owner.

---

## Usernames

### Two columns, one identity

```prisma
username      String? @db.VarChar(24)   // as typed, for display
usernameLower String? @unique           // the identity
```

A unique index is case-sensitive in Postgres, so without the normalized column
`AdaL` and `adal` would both be claimable and then resolve to the same profile
URL. The split is the same one `Tag.name` / `Tag.slug` already makes.

Both are null until claimed. Postgres does not treat NULLs as conflicting in a
unique index, so any number of unclaimed accounts can coexist.

### Rules

`src/users/username.util.ts`, alongside `tags/slugify.util.ts` and deliberately
built the same way — pure functions, callers decide how to reject.

- NFKD-folded with combining marks stripped, so `Café` becomes `cafe` rather than
  being rejected
- `^[a-z0-9_]{3,24}$` against the normalized form
- Not all digits — `123` is a phone number or a year, not a person
- Underscore, no hyphen: this identifies a person rather than describing a thing,
  and `@handle` reads correctly with one
- Cyrillic, Greek and CJK are rejected with a distinct message
  (`isUnsupportedScript`), the same gap tags already has

The character allowlist lives in the **service**, not as a `@Matches` on the DTO.
`class-validator` sees the raw string, where accented Latin has not folded yet and
uppercase is still uppercase — a pattern there would reject `Café` for a reason
that is not the user's fault. The service normalizes first, then validates.

### Availability

`UsersService.resolveClaim` checks in a fixed order, because each answer is a
different problem with a different fix:

1. **Unsupported script?** A gap we promised to close, so not reported as
   "invalid characters".
2. **Valid shape?** Length and charset.
3. **Reserved?** Checked before the availability read, so a reserved word reads
   as reserved rather than as "taken", which would invite a retry that also fails.
4. **Held by somebody else?**

### `ReservedUsername`

```prisma
model ReservedUsername {
  usernameLower String                  @id
  reason        ReservedUsernameReason  // RESERVED | RELEASED
  createdAt     DateTime                @default(now())
}
```

Every handle that has ever been issued, whether or not anybody holds it now.

`RESERVED` rows are seeded from `RESERVED_USERNAMES`: app routes (`settings`,
`share`, `resources`, …) so a user cannot shadow a page if the `/u/` prefix is
ever dropped, and words that would read as the product or as staff (`admin`,
`official`, `support`, `worthknowing`, …) so a stranger cannot publish a profile
that looks like us.

`RELEASED` rows are the reason the table exists. `applyClaim` writes the caller's
previous handle in the **same transaction** that grants the new one. Without
that, `ada` could be given away, taken by somebody else within the hour, and
re-registered by the original owner into a profile that now says something they
did not write.

Re-asserting the handle you already hold is not a change and releases nothing —
otherwise saving an unrelated bio would make your own username permanently
unclaimable by you.

The unique index on `ReservedUsername` is not the only guard; `User.usernameLower`
also has one, and a P2002 on either surfaces as the same 409 a deliberate
collision gets rather than as a 500.

---

## Two privacy mechanisms, and they are not the same thing

This is the distinction worth internalizing before touching either.

|                           | `isAnonymous` (per resource)                 | `isProfilePrivate` (per account) |
| ------------------------- | -------------------------------------------- | -------------------------------- |
| Decided                   | At creation, stored on the resource          | Any time                         |
| Effect                    | Withholds the **name** from public responses | Withholds the **profile page**   |
| Affects old contributions | No, never rewritten                          | No, never rewritten              |
| Default                   | `anonymousByDefault` preference              | `false`                          |

`ResourcesService.create` resolves `isAnonymous` once and stores it, so changing
`anonymousByDefault` later cannot alter what was already shared. Profile privacy
follows the same rule from the other side: a private profile still shows "Shared
by Ada" on the feed, because the contributor chose to share those publicly and
never asked to be unattributed. **Only the link goes away.**

### `profilePath`

`ContributorSummaryDto` carries a server-computed `profilePath: string | null`.

The rule lives on the server for the same reason `redactAnonymous` does: a client
working it out from `usernameLower` and `isProfilePrivate` would get it wrong
somewhere, and a wrong link points at a 404. The frontend's only job is _render
an anchor when it is a string, plain text when it is null_.

`null` in three cases, all meaning "the name is yours to read, but there is
nowhere to go from it":

- the profile is private
- the account has not claimed a username
- there is no contributor at all (deleted account, or an anonymous post)

A null `contributor` remains a different state — the name is genuinely withheld —
and `isAnonymous` is what tells a client which of the two it is looking at, so the
UI can word them differently.

### Why a private profile is a 404

`GET /users/:username` returns **404, not 403** for a private profile. A 403
would confirm the username exists, which is the one fact the contributor asked to
withhold — the response leaks by its own shape. 404 is indistinguishable from a
username nobody has ever claimed.

The owner check runs before the privacy test, so a private profile is still
visible and editable to its owner.

**Admins are not let through.** A moderation surface is a separate product with
its own design; a caller who needs to see a private profile is a caller who needs
that surface to exist first.

---

## Filtering a profile's contributions

```text
GET /api/v1/resources?contributor=adal
```

Reuses the existing keyset pagination — one cursor format, one response DTO —
rather than adding a second implementation of the same thing.

**Addressed by username, not by Clerk user id.** This is a `@Public()` route and
the id is the primary key of every account on the site; filtering by it would be
an enumeration surface.

The query parameter is folded before use, so `?contributor=AdaL` works. A
malformed value is a 400 rather than an empty page — `?contributor=ada-lovelace`
is a typo, and silently returning nothing reads as "this person has shared
nothing". An unknown-but-valid username _is_ an empty page, matching how an
unknown cursor behaves.

Anonymous contributions are not in the listing for anyone but the owner, because
`contributorId` is null on a row whose attribution was withheld.

---

## Seeding the reserved words

`RESERVED` rows come from `pnpm seed:reserved-usernames`
(`scripts/seed-reserved-usernames.ts`), **not** from a `prisma migrate` seed hook
— Prisma 7 removed those, and `prisma.config.ts` has no `seed` key.

Run it once after the migration that creates the table, and again whenever a word
is added to `RESERVED_USERNAMES`.

**It prints SQL and pipes it to `prisma db execute`, and it cannot work any other
way.** The generated Prisma client `require`s its own internals with a `.js`
extension that only resolves under the Nest build, so importing
`src/generated/prisma/client` from a bare `ts-node` script fails with
`Cannot find module './internal/class.js'` — at import time, before any of the
script's own code runs. `username.util.ts` has no imports of its own, so
generating SQL from it sidesteps the client entirely, the same way
`user-set-role.sh` avoids a TypeScript runtime.

Idempotency comes from `ON CONFLICT ("usernameLower") DO NOTHING`, so re-running
never overwrites a `RELEASED` row. The column list is `("usernameLower",
"reason")` only — naming `createdAt` would make Postgres expect a third
expression per row and fail with "INSERT has more target columns than
expressions", since the table declares `DEFAULT CURRENT_TIMESTAMP`.

---

## Adding a field to a profile

1. Add the column to `prisma/schema.prisma` — **you** run
   `pnpm prisma migrate dev`, then `pnpm prisma generate` (Prisma 7 does not
   generate automatically; see `AGENTS.md`).
2. Add it to `profileSelect` in `users.service.ts` if it is readable, and to the
   `ProfileResponse` type literal. The type is a literal rather than
   `Omit<ProfileRow, ...>` so a new `select` entry does not silently become part
   of the response.
3. Add a `@Is*` decorator to `UpdateMyProfileDto`. The global `ValidationPipe`
   runs with `forbidNonWhitelisted: true`, so a field without one is a 400.
4. If it is writable, add it to `applyProfileFields`. Only fields the DTO
   actually carries — spreading `undefined` sends an explicit null to a
   non-nullable column.
5. For a boolean, add `@Type(() => Object)` alongside `@IsBoolean`. The global
   `enableImplicitConversion` turns the string `"false"` into `true`, inverting
   the value — unacceptable on any flag.
