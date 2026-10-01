# Comments

Remarks on a resource. One flat, chronological list per resource, under
`/resources/:id`.

> **Status: schema only.** The `Comment` model, migration
> `20261001083312_add_comment_model` and `ResourceResponseDto.commentCount` exist.
> There are no routes yet. This document records the decisions the model already
> encodes, so they are settled before the service is written against them.

## What this is for

The product's loop is _discover → use → share_. Comments sit after the share: they
are the place where somebody who read your `why` says what they thought of it.

That is a narrower job than "community", and it is worth keeping narrow. Every
other thing a person contributes here is a link plus a reason, so the claim is
checkable against the thing it describes. A comment is the first free-text, public,
attributable thing on the site — prose about a link, rendered under a URL that gets
shared. That difference is what shapes everything below.

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

Landed in the same release, not after it — see the reasoning in the module README:

- Reporting (`POST /comments/:id/report`) and admin removal. A comment box with no
  way to hide a comment and no way to report one is a spam cannon pointed at the
  product.
- Per-route throttling. The global limit is 100 requests/minute, which is fine for
  reads and generous enough that one account could post 100 comments a minute.
- Whether editing a comment is allowed at all. Leaning **no**: delete-only, with no
  revision history. An edit with no visible marker lets somebody change what they
  argued after being called out on it.

## Schema

See [prisma.md](./prisma.md#comments).
