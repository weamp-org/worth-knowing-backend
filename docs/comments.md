# Comments

Remarks on a resource. One flat, chronological list per resource, under
`/resources/:id`.

> **Status: threads, reporting and a moderation queue.** Listing, posting, removing,
> reporting and an admin queue are all in. What is deliberately _not_ here is listed
> under [Still to be designed](#still-to-be-designed) — automatic hiding and report
> dismissal in particular.

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

| Route                                                    | Purpose                                   |
| -------------------------------------------------------- | ----------------------------------------- |
| `GET /api/v1/resources/:resourceId/comments`             | The thread, newest first. **`@Public()`** |
| `POST /api/v1/resources/:resourceId/comments`            | Comment, or reply with `parentId`. `201`  |
| `DELETE /api/v1/resources/:resourceId/comments/:id`      | Remove. Author or admin. `204`            |
| `POST /api/v1/resources/:resourceId/comments/:id/report` | Flag for a moderator. `204`               |
| `GET /api/v1/comment-reports`                            | The queue. **Admin only**                 |

The listing is the only `@Public()` route. Discussion is part of the public surface
of a resource, and `commentCount` is already on the public resource response — a count
a signed-out reader can see with nothing behind it would be the odd outcome.

Reporting needs a session — a report has to be attributable in order to be deduped —
but not an admin, because the point is that any reader can flag something. **Nothing
about a report is visible to anybody but a moderator**, including the comment's
author: showing it would turn a quiet signal into a scoreboard.

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

## Reporting is what a dislike was for

`POST .../:id/report` files a `CommentReport` row. It is idempotent — `createMany` with
`skipDuplicates`, against a composite primary key of `(reporterId, commentId)` — for
the same reason save is, and for one extra reason that matters more here: **it stops
one account padding a comment's report count** to make it look worse than it is.

A `409` would punish a double-click when the state the caller asked for already holds.

**You cannot report your own comment.** Not as a punishment — there is nothing to gain
by it — but because a queue containing reports an author filed on themselves is a queue
a moderator has to read past.

**The reason is optional and free text.** A required reason is a dropdown somebody has
to pick from before they can report something they plainly know is wrong. Capped at
500 characters, well below a comment's own 2000, because a report is a complaint and
the place to argue is the thread.

Reporting is throttled on the same 10/hour budget as posting. It is a write, and a
bored person could otherwise run a few thousand of them.

### The queue is `/comment-reports`, admin only

`@Roles(UserRole.ADMIN)` — the one place in this feature where the decorator can state
the rule, because there is no owner-of-the-queue alternative to accept.

It is mounted outside the resource path because a queue is not part of any one thread.
A moderator wants everything that has been flagged, ordered by when it was flagged;
asking for that through `/resources/:id/comments` would mean knowing which resource to
ask about.

**One row per report, not per reported comment.** That is the significant choice, and
it has a real cost: a comment five people reported takes five rows. Grouping is what a
moderator would rather act on, and it is not built — grouping means ordering by an
aggregate that changes while somebody is paging. One more report moves a comment you
already passed to the top of page one, duplicating or skipping rows. `docs/saved.md`
refused sort-by-saved for exactly this reason and the argument applies unchanged.

`reportCount` rides along on each row so the queue is still readable at a glance: one
report is a hunch, five is a pattern.

**The reporter is never named.** A moderator needs to know a report exists and what it
said, not who filed it — naming reporters makes reporting something with an audience,
and the people who file them are exactly the ones who should not be visible to each
other. `reportInclude` therefore never selects `reporterId`.

The comment comes along in its public shape, resolved through the same
`toCommentResponse` a reader's thread uses, so a moderator reads a reported comment
through the same code path a reader does. `isMine` is always false there: a moderator
is looking at somebody else's comment, and forwarding their own id would make their
own report render as their own comment.

Paged over `CommentReport` by `createdAt DESC, reporterId DESC, commentId DESC` — all
three columns are load-bearing, because `createdAt` is not unique and neither is
`reporterId` on its own.

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

- **Editing a comment.** Leaning **no**: delete-only, with no revision history. An
  edit with no visible marker lets somebody change what they argued after being called
  out on it, and nothing else in this codebase keeps a revision trail either.
- **Reporting a resource or a tag.** The model is comment-specific
  (`CommentReport.commentId`) and the queue is a comment queue. A resource can be
  removed by its contributor or an admin today with nothing to prompt it — the same gap
  `.../:id/report` closed for comments. Worth doing when a resource turns out to be
  the thing people actually want to report.
- **Automatic hiding at N reports.** Deliberately not built. Auto-hide lets a pile-on
  make a comment disappear with no human deciding, and with no reputation on this site
  yet there is nothing stopping three coordinated accounts from burying a thread.
  Moderation stays a person reading a queue.
- **Resolving a report without removing the comment.** A moderator who decides a
  reported comment is fine has no way to say so, so the row stays in the queue forever.
  Dismissing needs a `dismissedAt` and a filter; left out because there is not yet a
  moderator to be served by it.

## Schema

`Comment` and `CommentReport`, migrations `20261001083312_add_comment_model` and
`20261001090048_add_comment_reports`. See [prisma.md](./prisma.md#comments).
