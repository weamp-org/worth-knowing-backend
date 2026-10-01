# Comments

Remarks on a resource. One flat, chronological list per resource, under
`/resources/:id`.

> **Status: read and write routes exist; reporting does not.** Listing, posting and
> removing are in. Reporting and admin removal land next — see
> [Still to be designed](#still-to-be-designed) for why that is the same release
> rather than a later one.

## What this is for

The product's loop is _discover → use → share_. Comments sit after the share: they
are the place where somebody who read your `why` says what they thought of it.

That is a narrower job than "community", and it is worth keeping narrow. Every
other thing a person contributes here is a link plus a reason, so the claim is
checkable against the thing it describes. A comment is the first free-text, public,
attributable thing on the site — prose about a link, rendered under a URL that gets
shared. That difference is what shapes everything below.

## Routes

Nested under the resource, because a comment is meaningless without the `why` it
answers — and because nesting means the listing cannot be asked without naming what
is being discussed, which is what stops an unbounded "all comments on the site"
table from being the default.

| Route                                               | Purpose                                   |
| --------------------------------------------------- | ----------------------------------------- |
| `GET /api/v1/resources/:resourceId/comments`        | The thread, newest first. **`@Public()`** |
| `POST /api/v1/resources/:resourceId/comments`       | Comment, or reply with `parentId`. `201`  |
| `DELETE /api/v1/resources/:resourceId/comments/:id` | Remove. Author or admin. `204`            |

The listing is the only `@Public()` route. Discussion is part of the public surface
of a resource, and `commentCount` is already on the public resource response — a count
a signed-out reader can see with nothing behind it would be the odd outcome.

`POST` is `201`, not an idempotent `200` as on `/saved`. Posting the same text twice
is two comments; there is no unique row for the write to collapse onto.

`DELETE` is `204` with no body. Returning the comment with its text emptied would
invite a client to render "deleted" from a body with nothing left in it.

### The listing 404s before it paginates

A resource id that does not exist is a `404`, checked with one cheap `select: { id }`
read before the page query. The alternative is an empty thread, which reads as
"nobody has commented on this" — a claim about the discussion rather than an answer
about the resource, and a wrong one.

### An unknown cursor is a 400

Unlike the resource feed, where an unknown cursor is an empty page. The distinction is
what has gone missing: a resource can be _deleted_ between pages and that is a normal
thing to have happened, but a comment cannot be deleted without somebody choosing to,
so a cursor that names no row is a client bug worth reporting.

### Replies are capped at one level on write

`POST` with a `parentId` that is itself a reply re-points at the grandparent, so the
rendered thread stays one level deep whatever a client sends. See
[Replies are one level](#replies-are-one-level-and-stored-flat).

The parent is also scoped to the resource: a reply to a comment on another page is a
`404`, because it would otherwise render on the wrong thread.

### Delete is author-or-admin, in the service

The same rule `ResourcesService` applies to a contribution and `CollectionsService`
to a collection, and for the same reason — a comment is public content, so the product
asks for moderation that does not depend on the author being reachable.

It lives in the service rather than behind `@Roles` because `RolesGuard` short-circuits
on `if (!requiredRoles) return true`, so a route that must accept _either_ an author or
an admin cannot be expressed with that decorator.

The authorization read is scoped to **both** ids, so a comment id from another thread
is a `404` rather than a successful delete. Scoping before the role check is what
keeps the route from becoming a way to confirm that a comment id exists somewhere on
the site.

### Comments are throttled far harder than the global limit

`@Throttle({ default: { limit: 10, ttl: 3_600_000 } })` on `POST` — ten an hour. The
global limit is 100 requests a _minute_, which is right for reads and generous enough
that one account could post a hundred comments a minute. This is the only write on the
site that produces public free text, and no amount of after-the-fact reporting
un-sends it.

Ten an hour is still a lot of conversation for one person.

### No anonymity for a comment

A resource can be shared anonymously; a comment cannot. A resource is link-plus-reason,
so withholding the author still leaves the contribution legible. A comment is a
position taken in public conversation, and an anonymous one is close to a burner
account — with no reputation yet and throttling alone standing in the way.

Commenting _on_ an anonymous contribution is fine. `resourceId` is the only thing
tying a comment to a resource, and byline redaction happens on the resource read, so
there is nothing in this module that could un-withhold a contributor.

## The read shape

`comment-read.ts` holds it, extracted for the same reason `resources/resource-read.ts`
is: create and delete both return a comment, and without it each would grow its own
copy of the flattening.

- **`isMine` is server-decided.** Once the author has been reshaped into a summary,
  there is nothing left for a client to compare against the session. The same split
  `isOwner` and `isSaved` already use.
- **A parent's body is truncated** to 160 characters with an ellipsis. A 2000-character
  parent rendered in full inside every reply to it would bury the reply it frames. The
  comment's own `body` is never truncated — a reader who opens a comment wants all of it.
- **The parent's own `parentId` is not selected**, so there is nothing for a client to
  recurse into a tree this API does not have.

A null author means the account was deleted. That is a different state from a comment
that was never attributable, and a client should word the two differently.

## There is no like, and no dislike

**Rejected: a like.** `savedCount` is already the "other people found this worth
coming back for" signal, and `docs/saved.md` scopes it precisely as _interest, not
quality_. A like would fill the gap — but comments fill it more honestly, and the
like's main real-world function is to be the lazy alternative to writing a comment.
It is also the textbook engagement mechanic the product principles rule against:
next to Save, it is a second, weaker version of a button people already understand.

**Rejected: a dislike, which is why there is a report.** The reasoning matters more
than the verdict:

- There is no ranking for a vote to act on. The feed is chronological by choice,
  and sort-by-saved is refused on purpose. In a chronological feed a downvote has
  **no mechanical function** — it is a punishment signal with nothing to demote.
- It attacks the core loop. The central act is "I found this worth knowing", and a
  visible downvote counter tells people their excitement is unwelcome. That lands
  hardest on exactly the people the product is built to attract.
- It is not undoable. Changing your own mind is one click; you cannot un-downvote
  somebody else's experience of it.

The one real job a downvote does is flagging something for removal. That job is
called a report, and it is moderation tooling rather than a vote.

So: **no karma, no votes, no score.** `commentCount` is a count of remarks, not a
quality rating, and nothing is ranked by it.

## Flat and chronological

The listing is `WHERE resource_id = ? ORDER BY created_at DESC, id DESC`,
keyset-paginated like every other list in the system. Newest first, with `id` as the
tiebreaker because `createdAt` is not unique.

Newest-first rather than Reddit's `old` default, because Reddit can default to `old`
only because it also has a `best` tab driven by votes. With no votes there is nothing
to rank by, and chronological is both the honest default and the one consistent
with the rest of the site.

## Replies are one level, and stored flat

**Rejected: a reply tree.** "I disagree with the comment above" is the most common
thing anybody wants to say, so replies are clearly worth having. A _tree_ is the
expensive version: it needs a cursor carrying a materialised path, and "load more"
then has to fetch children of comments that may not be on screen. Every list in this
schema is a keyset page over `(createdAt, id)`, so a tree would mean rewriting that
primitive for a depth nobody has asked for.

**Adopted: a nullable `parentId`, one level only.** Replies are stored _flat_ and
read in the same chronological order as everything else; the parent's text is
rendered as a quote above the reply. The row shape and the cursor are identical to
an unthreaded list — only the rendering differs.

A deeper tree, or no replies at all, remains reachable later without a breaking
change. `parentId` is nullable and carries no uniqueness constraint.

## Three delete rules, three reasons

| FK           | Rule                | Why                                                                                                                                                                                                                                                              |
| ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resourceId` | `Cascade`           | A comment on a resource that no longer exists has no referent, and deleting a resource is a hard delete for everybody.                                                                                                                                           |
| `authorId`   | `SetNull`, nullable | A comment is somebody's words and outlives its author for the same reason a contribution does — see the reasoning on `Resource.contributor`. Clerk deletes accounts on its own schedule, so this is a real path, not a hypothetical one. Renders as `[removed]`. |
| `parentId`   | `SetNull`           | Deleting a comment drops the quote on its replies rather than cascading **other people's words** away.                                                                                                                                                           |

The `authorId` rule is the one most likely to be got wrong later. Never `Cascade`:
deleting an account must not take every remark with it.

## `commentCount` is public

On `ResourceResponseDto`, flattened from `_count.comments` in `withProfilePath`, for
the same reason `savedCount` is: the resource page shows the count to prompt the
discussion, whether or not the reader has signed in.

Unlike `savedCount` it is **not** a signal of interest — it says nothing about the
resource, only that people talked about it. It exists to render "3 comments" and a
link to them, so a page needs it without a second request.

## Still to be designed

- **Reporting** (`POST /resources/:resourceId/comments/:id/report`) and an admin view
  of what has been reported. This is the one piece that must not be deferred further:
  admin _removal_ already exists, so nothing is invisible — what is missing is the
  signal that tells a moderator where to look. Until it lands, the moderation path
  works only for somebody who already knows about a comment.
- **Editing a comment.** Leaning **no**: delete-only, with no revision history. An
  edit with no visible marker lets somebody change what they argued after being called
  out on it, and nothing else in this codebase keeps a revision trail either.

## Schema

See [prisma.md](./prisma.md#comments).
