# Notifications

One inbox per person: a comment on something you shared, or a reply to
something you said. Nothing else — no saves, no trends, no digests. Those are
engagement optimisation, which this product explicitly does not do.

## The model points; it does not snapshot

A `Notification` row carries the participants (`recipient`, `actor`,
`resource`, `comment`), not their words. The actor's name, the resource's
title and the comment's body are resolved on read, so an edit or a deletion
upstream shows up in the inbox instead of embalming a stale copy.

The cost of pointing is that a deleted comment leaves a row pointing at
nothing. That is handled, not prevented:

- `resource` cascades. A notification about a resource that no longer exists
  has no referent and nowhere to link — the same reasoning as `Comment`'s own
  `resourceId` — so the row goes with it.
- `comment` is `SetNull`. A reply notification whose comment was removed is
  still news that somebody answered; the read renders "a comment" rather than
  dropping the row.
- `actor` is `SetNull`. A remark outlives its author here the same way it does
  in the thread; the read renders "Someone".
- `recipient` cascades. An inbox belongs to its owner, and a notification for
  nobody is nothing.

`readAt`, not a boolean: unread is the null state, reading stamps it, and
"mark all read" is one `updateMany`.

## Filing happens after the write, and never fails it

`CommentsService.create` calls `NotificationsService.notifyForComment` after
the comment is stored — never before, so a notification can never point at a
comment that failed to store. The fan-out itself never throws: the remark is
the contribution and the notification is its echo, so a broken inbox must not
fail a comment. Failures go to the logger as warnings, which is where a broken
inbox becomes visible instead of silent.

Two things earn nothing: your own comment (a row where actor and recipient
coincide is treated as a bug, not a state), and a comment whose recipient is
gone — a deleted account leaves a null author or contributor, and there is
nobody to tell.

Replies notify the author of the _effective_ parent — the row the reply
attaches to after `resolveParentId` flattens depth — which is the same comment
the thread quotes above it.

## Routes

All require a session. **Nothing here is `@Public()`.** A notification names
who said what about whose contribution, and there is no public version of
that.

| Route                             | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `GET /notifications`              | Your inbox, newest first, keyset-paginated |
| `GET /notifications/unread-count` | How many are unread — the bell polls this  |
| `PATCH /notifications/:id/read`   | Mark one read; returns it                  |
| `POST /notifications/read-all`    | Mark everything read; returns the count    |

The single-read write is scoped to the caller (`updateMany` on
`{ id, recipientId }`), so a row that is not yours matches nothing and 404s —
leaking neither its existence nor its content. Reading what is already read
succeeds and re-stamps rather than rejecting: "read" is already the state the
caller asked for.

## Push delivery

One browser is one `PushSubscription` row, keyed by the push service's
endpoint: a user on a phone and a laptop is two rows, and every notification
goes to all of them. Re-subscribing upserts, so toggling push off and on
cannot stack duplicates; unsubscribing deletes, scoped to the caller.

Sending fans out from the recipient's live rows right after the inbox write —
after, never instead: push delivers the inbox, and a delivery failure must not
un-file what was earned. A dead subscription (404/410 from the push service —
the browser left without saying goodbye) is pruned on sight, so the table
cannot fill with rows that only ever fail. Anything else warns and moves on.

VAPID keys come from `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
`VAPID_SUBJECT` (see `.env.local.example`). Without all three, push stays
disabled with one loud warning rather than throwing at boot: a fresh clone has
placeholder keys, and the inbox the pushes would deliver works without them.
The public key is served to signed-in browsers at
`GET /notifications/push-public-key`; the private key never leaves the server.

| Route                                      | Purpose                       |
| ------------------------------------------ | ----------------------------- |
| `GET /notifications/push-public-key`       | The VAPID public key, or null |
| `POST /notifications/push-subscriptions`   | Subscribe this browser        |
| `DELETE /notifications/push-subscriptions` | Forget this browser           |
