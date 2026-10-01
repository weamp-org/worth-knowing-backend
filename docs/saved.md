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

## Sorting by saved count is deliberately absent

`/saved` is newest-saved first. There is **no** sort-by-saved, and no "most saved"
rail on the home page.

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

## Anonymity is unaffected

Saving is not a way to un-withhold a name, and it never re-attributes a resource
to whoever saved it. A saved list goes through the same `toResourceResponse` as
every other public resource read, so an anonymously shared resource stays
anonymous in your own list.

## Schema

`SavedResource(userId, resourceId, savedAt)`, migration
`20260930082504_add_saved_resources`. See
[prisma.md](./prisma.md#saved-resources).
