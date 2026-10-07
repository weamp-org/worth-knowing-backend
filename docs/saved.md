# Saved resources

A bookmark, with no grouping attached. One click on a resource, and it lands on
`/saved`.

## Not a collection

This is the whole design decision, so it is worth being explicit about what was
rejected.

The tempting shortcut is to give every user a system-owned "Saved" collection. It
was rejected because:

- A **collection is a curation** — the owner is saying "these belong together,
  and here is why". A save is one click with no such claim. Folding them together
  makes `description` meaningless on the one list everybody has.
- Every listing query would need `WHERE id != 'saved'` so it does not leak into
  profile pages, and the picker would need to special-case a list that cannot be
  renamed, published or deleted.
- Deleting a user cascades their collections. Deleting a user must not delete
  their bookmarks, so it would be fighting its own cascade rule.

They are two concepts and each is honest about what it is.

## Saving and collecting are independent

Saving something and later adding it to a collection leaves **both** intact. The
bookmark is sometimes the only copy somebody has, and removing it without being
asked would be magic. The alternative — auto-unsave on collect — is a tidier
mental model ("Saved = not yet filed") and is a deliberate non-choice.

`saved.service.spec.ts` and `test/saved.e2e-spec.ts` both assert this: the save
and unsave writes touch one row and nothing else.

## Routes

All require a session. **Nothing here is `@Public()`.**

| Route                              | Purpose                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `GET /api/v1/saved`                | Your saved resources, newest saved first, keyset-paginated |
| `GET /api/v1/saved/:resourceId`    | `{ isSaved: boolean }` for the button's initial state      |
| `POST /api/v1/saved`               | Save. Body is `{ resourceId }`                             |
| `DELETE /api/v1/saved/:resourceId` | Unsave                                                     |

A bookmark list is the most private thing a person has here — the one collection
of resources they have chosen without saying why. Unlike a resource or a profile
there is no public version of it.

`POST` is `200`, not Nest's default `201`, because nothing is created on a repeat.

## Idempotent both ways

Save is `createMany({ skipDuplicates: true })`; unsave is `deleteMany`. The
primary key is what prevents a duplicate, and `skipDuplicates` is race-safe in a
way a read-then-write check is not — two clicks landing together produce one row
rather than one row and a P2002. A `409` would punish somebody for a
double-click, and the end state they asked for already exists.

## Ordering is when you saved it, not when it was shared

Paged over `SavedResource` by `savedAt DESC, resourceId DESC`. For a two-year-old
contribution saved yesterday, the resource's own `createdAt` would sort your
bookmark list into the wrong order entirely.

`resourceId` is the tiebreaker because `savedAt` is not unique, and the cursor is
the composite key `(userId, resourceId)` because `resourceId` alone is not unique
— a resource can sit in many people's saved lists. `userId` comes from the
session, so the opaque cursor only carries the half that varies.

## `savedCount` is public, on every resource response

`resourceInclude` now selects `_count.savedResources`, and `withProfilePath`
flattens it to `savedCount`. So the feed, a resource page, a collection's
contents and `/saved` all show the count with no second request.

It is a signal of **interest**, not of quality — it says people came back for it,
not that it is the best one here. That distinction is why it is on the public
response rather than hidden behind a signed-in read.

`GET /saved/:resourceId` is separate because _your_ having saved it is the one
per-viewer part.

`_count` is a Prisma artefact and never reaches a client; the flattening happens
in `withProfilePath` for the same reason the contributor's raw fields are replaced
with a resolved `name` and `profilePath`.

## Sorting by saved count is deliberately absent on any paginated list

`/saved` is newest-saved first, and `savedCount` is **not** a `ResourceSort`. There
is no `?sort=most-saved`, and `GET /resources` will never accept one.

Two reasons, both settled:

- Sorting a paginated list by an aggregate is materially harder than by a column.
  The cursor can no longer be a bare `id` — it needs `(saveCount, id)` — and the
  count **changes while somebody is paging**. Save something on page one and a
  resource you already passed can move ahead of you, giving duplicates or skipped
  rows.
- Ranking the whole feed by saves buries the newest contribution the moment
  anybody saves anything, and leaves the surface answering two questions at once
  ("newest" or "best"?).

Sorting is worth doing eventually, but only on a **filtered** view — a tag or a
contributor — where it is opt-in rather than the default posture of the site.

### `GET /resources/top-saved` — the exception, and why it is safe

The home page has a **most-saved rail**: a fixed top-N, by default six, with no
cursor and no `nextCursor`.

That is not a contradiction of the above, it is the one case the objection does not
reach. The reason `savedCount` is absent from `ResourceSort` is that the count
_moves while somebody pages_ — and a rail has no page two, so there is nothing for
it to move beneath. The reasoning above is about pagination, not about the count
being untrustworthy.

Three properties keep the exemption honest rather than a loophole:

- **It is not reachable as a sort.** `mostSavedOrderBy` is a separate export, not
  a `ResourceSort` member, so `?sort=most-saved` on `GET /resources` is still a 400. Adding it to the enum is exactly the change that would reintroduce the bug,
  because `GET /resources` _is_ paginated.
- **It cannot page.** `TopSavedQueryDto` deliberately does **not** extend
  `PaginationQueryDto`: it carries no `cursor`, so `?cursor=` is a 400 under
  `forbidNonWhitelisted` rather than a parameter that validates and is dropped.
- **It excludes zero-saves.** `where: { savedResources: { some: {} } }`. Ordering by
  count and returning the first six regardless would put a "Most saved" heading
  above six resources nobody has saved — which on a young site is most of them, and
  is a false statement rather than a thin section. So the rail returns fewer than
  `limit` rows, or none, and the home page collapses the section instead of padding
  it.

The ceiling is `MAX_TOP_SAVED = 24`, well under `MAX_PAGE_SIZE`. The gap is
deliberate: this ordering is a relation count, computed with a join or aggregate
over `SavedResource` rather than from an index on `Resource`, and nothing on a
homepage rail legitimately needs 100 rows.

### Worded "Most saved", never "Best"

`savedCount` is a signal of **interest**, not of quality — the same distinction that
puts it on the public response. The count says people came back for something, not
that it is the strongest thing on the site. The heading is part of the feature: a
rail labelled "Best" would be claiming an editorial judgement the data does not
support, on the most-read surface on the site.

It is also, on a seeded corpus, close to static: the top handful stop moving once
they are in place. That is tolerable for a secondary rail and would not be for the
default ordering of the feed, which is the other half of why `findAll` does not
rank this way.

## Anonymity is unaffected

Saving is not a way to un-withhold a name, and it never re-attributes a resource
to whoever saved it. A saved list goes through the same `toResourceResponse` as
every other public resource read, so an anonymously shared resource stays
anonymous in your own list.

## Schema

`SavedResource(userId, resourceId, savedAt)`, migration
`20260930082504_add_saved_resources`. See
[prisma.md](./prisma.md#saved-resources).
