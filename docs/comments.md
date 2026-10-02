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
| `GET /api/v1/resource-reports`                           | The contribution queue. **Admin only**    |
| `POST /api/v1/resource-reports/:resourceId/dismiss`      | Keep it, close the reports. `204`         |
| `GET /api/v1/comment-reports`                            | The comment queue. **Admin only**         |
| `POST /api/v1/comment-reports/:commentId/dismiss`        | Keep it, close the reports. `204`         |

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

## Reporting

Two kinds, both replacing the dislike this feature deliberately has no vote for:

| Route                                             | Flags                  | Who can file one                         |
| ------------------------------------------------- | ---------------------- | ---------------------------------------- |
| `POST /resources/:resourceId/report`              | the contribution       | any signed-in reader but its contributor |
| `POST /resources/:resourceId/comments/:id/report` | a comment              | any signed-in reader but its author      |
| `GET /resource-reports`                           | the contribution queue | admin only                               |
| `GET /comment-reports`                            | the comment queue      | admin only                               |

**A contribution is the higher-leverage report.** A bad comment is one person's remark
under one page; a bad link gets shared onward, repeatedly, to people who never saw the
flag. That is why resource reporting exists and why it is not folded into the comment
one.

**Neither is an anonymity escape, and a comment is not a back door around one.**
Commenting _on_ an anonymously shared contribution is fine: `resourceId` is the only
thing tying a comment to a resource, and byline redaction happens on the resource read,
so nothing in the comments module can un-withhold a contributor.

### Both are idempotent, and that matters more here than for a save

`createMany` with `skipDuplicates`, against a composite primary key of
`(reporterId, targetId)`. A `409` would punish a double-click when the state the caller
asked for already holds — but the second reason matters more: **it stops one account
padding a report count** to make something look worse than it is. A unique index on the
target alone would have allowed that.

**You cannot report your own.** Not as a punishment — there is nothing to gain by it.
The contributor can delete their own contribution and the author can delete their own
comment, so a self-report is never what is needed, and a queue containing one is a queue
a moderator has to read past.

**The category is required; the free text is optional.** That split is the whole
design, and it is the opposite of what it first was — an optional free-text `reason`
and nothing else.

A queue of free text has to be read one report at a time before a moderator can group
anything, which is what makes a queue expensive to work through. With categories it
reads as "12 spam, 3 broken links", and the shape of the volume says something on its
own. The optional `detail` is what keeps the case that motivated the original design
served: somebody who knows exactly what is wrong picks the nearest fit and adds a
sentence if they want to.

### The categories are organised by the decision they imply

Not by severity, and not by how a reporter would describe the problem — by what a
moderator should _do_ about it. A queue sorted by category is only worth sorting by if
the categories separate the actions.

`ResourceReportReason` — `SPAM` and `ABUSE` are remove; `BROKEN_LINK` and
`WRONG_RESOURCE` are usually a fix; `SOMETHING_ELSE` is the escape hatch.

`CommentReportReason` — `SPAM` and `ABUSE` are remove; `OFF_TOPIC` is a judgement call
a moderator may reasonably leave; `SOMETHING_ELSE` is the escape hatch.

`BROKEN_LINK` and `WRONG_RESOURCE` are **not removal cases**, and that is why the UI
does not ask "why should this be removed?". Somebody wrote a careful `why` for a link
that now 404s; the honest outcome is usually to fix the link or the title, and the
product loses something real by throwing the contribution away.

### There is deliberately no `DUPLICATE`

The category every directory would have first, and the one this product must not.

Two different people independently sharing the same link **is the feature working** —
each brings a different `why`, and that is the value; see
`@@unique([contributorId, url])` on `Resource`. A repeat submission by the _same_
contributor is already refused with a 409, so a duplicate report could only ever be
pointing at something that is meant to be there, and offering a moderator the chance
to act against that would be worse than not having the option.

`detail` is capped at 500, as the comment body was — a report is a complaint, not a
second contribution.

Both are throttled on the same 10/hour budget as posting, via `PUBLIC_WRITE_THROTTLE`
in `src/throttle.ts`. Reporting is the same kind of act as writing, and three copies of
that number would be free to drift.

### Two tables, not one polymorphic `Report`

The single-table design was the first plan and it cannot work. Postgres makes
`PRIMARY KEY` columns implicitly `NOT NULL`, so a nullable target cannot be in a
composite key; and `@@unique([reporterId, resourceId])` does nothing for a comment row,
because Postgres treats NULLs as _distinct_ in a unique index. The unified table would
have had to enforce idempotency in application code — a read-then-write that loses the
race a primary key does not — and refusing the duplicate is the whole point of keying a
report on `(target, reporter)`.

Two near-duplicated models buy back DB-enforced idempotency and a real cascade. See
`resources/report-read.ts` and the schema comments.

### The queues

Both are `@Roles(UserRole.ADMIN)` — the one place where the decorator can state the
rule, since there is no owner-of-the-queue alternative for a non-admin to be. Mounted
outside the resource path, because a queue is not part of any one resource or thread.

**One row per report, not per reported thing.** That is the significant choice, and it
has a real cost: a comment five people reported takes five rows. Grouping is what a
moderator would rather act on, and it is not built — grouping means ordering by an
aggregate that changes while somebody is paging. One more report moves something you
already passed to the top of page one, duplicating or skipping rows. `docs/saved.md`
refused sort-by-saved for exactly this reason and the argument applies unchanged.

`reportCount` rides along on each row so the queue is still readable at a glance: one
report is a hunch, five is a pattern.

**The reporter is never named.** A moderator needs to know a report exists and what it
said, not who filed it — naming reporters makes reporting something with an audience,
and the people who file them are exactly the ones who should not be visible to each
other. Neither report include selects `reporterId`.

**An anonymously shared contribution is still redacted in the resource queue.**
`toResourceReportResponse` routes it through the ordinary public `toResourceResponse`
with no viewer, so a moderator does not get to un-withhold a name. `isAnonymous` is a
promise the contributor made, and the person most likely to be tempted to break it is
not a stranger on the feed but a moderator with a queue in front of them. They do not
need the name to decide that a link is spam.

The comment comes along in its public shape too, through the same `toCommentResponse`
a reader's thread uses. `isMine` is always false there: a moderator is looking at
somebody else's comment, and forwarding their own id would make their own report render
as their own comment.

Both queues page over their report table — newest _report_ first, not newest target —
for the same reason `SavedService.findMine` pages over the save. Ordering
`createdAt DESC, reporterId DESC, targetId DESC`; all three columns are load-bearing,
because `createdAt` is not unique and neither is `reporterId` alone.

An unknown cursor is a `400` in both queues, where the resource feed would answer with
an empty page. A comment or a resource only disappears when somebody chooses to remove
it, so a cursor naming no row is a client bug worth reporting.

The shared cursor pair lives in `pagination/cursor.util.ts` rather than being written
twice, and encodes **target first** (`commentId:reporterId`) so the two queues produce
identical shapes even though both primary keys are actor-first.

## Dismissing

```
POST /api/v1/resource-reports/:resourceId/dismiss    204, admin only
POST /api/v1/resource-reports/:resourceId/undismiss  204, admin only
POST /api/v1/comment-reports/:commentId/dismiss      204, admin only
POST /api/v1/comment-reports/:commentId/undismiss    204, admin only
```

"I looked at this and it stays." The third thing a moderator can do with a report,
alongside removing it and doing nothing.

**Without it there was no way to record that decision**, so the only way to work
through a queue was to delete things — which quietly makes removal the answer to every
report, including the ones where removal is wrong. A queue a moderator cannot clear is
a queue they stop trusting: it grows forever, or they learn to ignore it, and both make
the _next_ real report less likely to be caught. For `BROKEN_LINK` on a carefully
written `why`, "keep it and fix the link" is very often the right answer and there was
nowhere to say so.

### It applies to every report on the target, not one of them

A comment five people reported is five rows. Dismissing one would leave four still
queued — which is to say the queue could never actually be worked through. So the write
is `updateMany` over every report for the target, and both routes take the **target** id
rather than a report id.

### It is not a deletion

The comment or contribution is untouched, the report rows are kept, and the queue simply
stops returning them. That is what makes it reversible: un-dismissing is
`dismissedAt = null` rather than an `INSERT` to undo. Both queues filter on
`dismissedAt: null` — dismissed rows are **invisible, not shown-and-greyed**, because a
greyed row in a queue is a row somebody has to reason about to know it can be skipped.

Deliberately **no `dismissedBy`**. There is no audit surface to read it back on, and a
column nobody queries is a claim about accountability this product does not make. The
route therefore takes no session either.

`204` and deliberately not `DELETE`: nothing is deleted, and the verb should not say
otherwise.

Idempotent — `where: { dismissedAt: null }` means a second dismissal matches nothing
rather than erroring, because two moderators reaching for the same row at once is
ordinary and neither should see a failure for it. Same reasoning as `POST /saved` and
`DELETE /saved/:resourceId`.

### Dismissal asks nothing, and is undoable instead

**No confirmation dialog**, deliberately — and this is a decision, not an omission.

The argument for confirming is that a mis-click is permanent in practice: the column is
reversible in the database, but with no way back through the UI, "reversible" is a
comfort nobody gets. That is a real gap.

The better fix is **Undo on the toast**, which is what the client offers, and it beats a
dialog for two reasons:

- A confirmation costs every moderator an extra click on the **safe** action to guard
  against one rare mistake. It also makes dismissal feel as heavy as removal, and then
  the path of least resistance is remove-or-do-nothing — friction on exactly the
  decision a moderator should be making more often.
- A dialog on every moderation action is how people learn to click through dialogs,
  including the delete one, which is the only one that genuinely needs reading. The
  same principle is already written down in `docs/profiles.md`: _"a dialog on every
  save is how people learn to click through dialogs."_

So the line is **confirm the irreversible action only**. Removing a comment or
contribution is permanent and un-undoable, so it asks. Closing a report is neither, so
it does not.

`undismiss` is the inverse: `dismissedAt: null` on every row for the target that is
not already null. Only rows a dismissal actually closed are reopened — a report filed
_after_ the dismissal is already `dismissedAt: null` and already queued, so this leaves
it exactly where it is rather than disturbing a report nobody resolved.

### A report filed after a dismissal comes back

Dismissal is per `(target, reporter)` row, so a _new_ report from someone else is a new
row with `dismissedAt: null` and reappears in the queue on its own. That is right — it
is new information rather than a re-run of a decision somebody already made.

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
- **Reporting a tag.** Resources and comments can be flagged; a tag cannot, and a tag is
  reachable from every resource carrying it. Worth doing when a tag turns out to be the
  thing people actually want to report.
- **Automatic hiding at N reports.** Deliberately not built. Auto-hide lets a pile-on
  make a comment disappear with no human deciding, and with no reputation on this site
  yet there is nothing stopping three coordinated accounts from burying a thread.
  Moderation stays a person reading a queue.
- **A "show dismissed" view.** Un-dismissing is built; seeing what a colleague closed is
  not. It would be a `?dismissed=true` filter on both queues, and left out because
  there is no evidence anyone needs to audit a dismissal rather than make one.

## Schema

`Comment` and `CommentReport`, migrations `20261001083312_add_comment_model` and
`20261001090048_add_comment_reports`. See [prisma.md](./prisma.md#comments).
