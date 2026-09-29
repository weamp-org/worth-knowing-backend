# Collections

A collection is a gathering of resources somebody chose to keep together. The
owner is usually saving links _other people_ shared, and the `why` on each
resource is still its original contributor's — so the relation is named `owner`,
not `contributor`, which everywhere else in the schema means "the person who
wrote this".

## Routes

All prefixed with `api/v1`.

| Route                                           | Guard  | Purpose                                                                            |
| ----------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `GET /collections/me`                           | auth   | Your own collections, newest first. `?resourceId=` adds `containsResource` per row |
| `GET /collections/:id`                          | public | One collection. `404` if private and not yours                                     |
| `GET /collections/:id/resources`                | public | Its contents, newest collected first, keyset-paginated                             |
| `POST /collections`                             | auth   | Create. Private unless you say otherwise                                           |
| `PATCH /collections/:id`                        | auth   | Rename, redescribe, change visibility (owner or admin)                             |
| `DELETE /collections/:id`                       | auth   | Delete (owner or admin)                                                            |
| `POST /collections/:id/resources`               | auth   | Add a resource (owner only)                                                        |
| `DELETE /collections/:id/resources/:resourceId` | auth   | Remove one (owner only)                                                            |

`GET /collections/me` is declared before `GET /collections/:id` in
`collections.controller.ts`. Nest matches in declaration order, and keeping the
literal first means a collection id can never shadow it.

## The description

Optional, `VarChar(500)`, and the reason it exists is the product thesis. A
resource already carries its contributor's `why`; a public collection without a
description is a titled list of other people's links with no reasoning attached,
which is the one thing this product should not render. It is where the curator's
reason for the _grouping_ lives — the same judgment as a `why`, one level up.

Optional because a plain folder is a legitimate thing to want.

## Visibility

`isPrivate`, defaulting to `true`.

A private collection is a **404 for anyone but its owner**, not a 403, and the
two cases throw the same message. A 403 would confirm the collection exists,
which is itself the answer the owner declined to give. This is the same call
`UsersService.findByUsername` makes on a private profile.

`isPrivate` does **not** re-attribute anything inside. A resource collected
anonymously is still redacted when the collection is public — see below.

## Anonymity holds across the collection boundary

This is the constraint that shaped the code layout.

Making a collection public exposes its contents publicly, and an anonymous
contribution is exactly the thing that must not become newly discoverable through
a second route. So `Collection`'s contents go through **the same** redaction as
any public resource read — the same `redactAnonymous`, the same `withProfilePath`.

That is why `resourceInclude` and the two mappers were extracted out of
`ResourcesService` into `src/resources/resource-read.ts` rather than copied into
`CollectionsService`. A second copy of the anonymity rule is a second chance to
get it wrong, and the failure mode is deanonymizing somebody who asked not to be
named.

`toResourceResponse` exists so the _order_ is right in one place. `redactAnonymous`
nulls the contributor, so running it after `withProfilePath` would resolve a
display name for a row that is about to have its attribution withheld.

Consequence worth knowing: putting an **anonymous** resource into a **public**
collection gives that resource a second, stable, linkable URL. It does not
deanonymize it — the byline still reads as anonymous — but it is a new way to
find it.

## Authorization: two different rules

| Action                            | Who                |
| --------------------------------- | ------------------ |
| `PATCH`, `DELETE` the collection  | Owner **or** admin |
| Add / remove a resource inside it | Owner only         |

The split is deliberate. Renaming or deleting a collection is moderation: a
public collection is public content, and the product asks for moderation that
does not depend on the owner being reachable. _Adding a link to somebody's
reading list_ is not — it is a private arrangement of their taste, there is no
content reason for anyone else to have an opinion about it, and an admin quietly
inserting a link would be indefensible.

Both live in the service rather than behind `@Roles`, because `RolesGuard`
short-circuits on `if (!requiredRoles) return true`. A rule that admits _either_
an owner or an admin cannot be expressed with that decorator, so nothing would
ever ask what role the caller has.

## Any resource, not only your own

A collection is how somebody says "these are worth knowing together", and the
resources in it are overwhelmingly not theirs. Restricting it to your own
contributions would leave collections a second, worse view of your profile page.

## `containsResource`, and why it is on the list route

`GET /collections/me?resourceId=…` answers "does this collection already hold
that resource" for every one of your collections in **one** query — one
`collectionResource.findMany` scoped to the page's ids, not one request per
collection. The picker on a resource page renders a saved/unsaved state for
every list you own, so this is the difference between one round trip and N.

The field is `false` for every row when the client did not send `?resourceId=`,
and the query is skipped entirely. It is a convenience flag, not a claim about
anything: reading it as `true` when the question was never asked is a bug the
API shape invites, so only send the parameter when you have a resource in hand.

The same shape as `ProfileResponseDto.isOwner`, which is `true` on
`GET /users/me/profile` and `false` on a signed-out read.

## `isOwner` and `profilePath` are never re-derived

Both are computed server-side. A client that worked `profilePath` out from
`usernameLower` and `isProfilePrivate` itself would get it wrong somewhere, and
the result is a link to a 404 rather than an obviously broken page.

`resolveProfilePath` in `users/display-name.util.ts` is the single implementation,
shared with the resource byline. Null means "there is nowhere to link to" — a
private profile, or no username claimed. It never means the name is hidden; that
is a null `contributor`, which is a different thing and worded differently.

## Idempotency, and a 200 that is not a 201

`POST /collections/:id/resources` answers **200**, via an explicit
`@HttpCode(HttpStatus.OK)`. Nest would default a `POST` to 201, but nothing is
created — the row either exists or is a no-op — so a 201 would tell a client it
was, and would be wrong on the second call. `DELETE` is 200 for the same reason.

`createMany({ skipDuplicates: true })` is what makes a double-click succeed, and
it is race-safe in a way a read-then-write check is not: two clicks landing
together produce one row rather than one row and a P2002.

`removeResource` uses `deleteMany` and does not require the resource to still
exist. If it was deleted outright its join rows cascaded away, and the caller's
request has still been honoured — so it is a 200, not the 404 that `addResource`
gives for a resource id that names nothing.

## Ordering is the join's, not the resource's

Contents are paged over `CollectionResource` ordered by `addedAt DESC,
resourceId DESC`. A resource's own `createdAt` is when it was _shared_; a
collection needs when it was _collected_. Ordering by the former would be a
different and wrong list.

There is no `position` and no drag-and-drop reordering. A hand-ordered list is a
feature nobody has asked for, and it would make every reorder a write to every
row after it.

## The compound cursor

`resourceId` is not unique on its own, so Prisma refuses it as a cursor. The
composite primary key does the job, and `collectionId` is already in the path —
see [prisma.md](./prisma.md#the-compound-keyset-cursor).

## Curation happens after sharing, not during

There is no "add to a collection" step in `POST /resources`. The central
contribution stays exactly as simple as it was, and a resource is collected later
from its own page. The API is the same either way, so this is a pure later
addition rather than a redesign.

## Tests

`collections.service.spec.ts`, `collections.controller.spec.ts` and
`test/collections.e2e-spec.ts`. No database, no env vars, no Clerk keys — see
[testing.md](./testing.md).

The controller spec asserts guard metadata through
`Object.getOwnPropertyDescriptor(...).value` rather than `prototype[name]`,
which trips `unbound-method` for what is really a value lookup.

## Schema

`prisma/schema.prisma`, migration
`20260929152449_add_collection_model`. See [prisma.md](./prisma.md#collections)
for the join model, the cascade that differs from `Resource.contributor`, and
the cursor.
