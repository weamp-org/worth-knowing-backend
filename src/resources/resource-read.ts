import { Prisma } from '../generated/prisma/client';

import {
  resolveDisplayName,
  resolveProfilePath,
} from '../users/display-name.util';

/**
 * The read shape for a resource, and the two transformations every read has to
 * apply before it leaves the service.
 *
 * Extracted from `ResourcesService` rather than left private to it, because
 * `CollectionsService` has to answer the same question for a *different* set of
 * resources: the ones somebody has gathered into a collection. Making a
 * collection public exposes its contents publicly, and an anonymous contribution
 * whose author asked not to be named is exactly the thing that must not become
 * newly discoverable through that route. So the redaction has to travel with the
 * read, not be reimplemented — a second copy of `redactAnonymous` is a second
 * chance to get the anonymity rule wrong.
 *
 * What lives here is only the *shape* of a resource read. Which resources, in
 * which order, and who may see them is each service's business.
 */

/**
 * Read shape for the public API. A resource whose contributor has been deleted
 * is still returned, just without the attribution.
 */
export const resourceInclude = {
  contributor: {
    select: {
      id: true,
      name: true,
      imageUrl: true,
      // Read only to build `profilePath` and to resolve a display name. Neither
      // reaches the response. See {@link withProfilePath}.
      username: true,
      usernameLower: true,
      isProfilePrivate: true,
    },
  },
  tags: { orderBy: { name: 'asc' } },
  // Never redacted and never per-viewer: "how many people saved this" is a
  // public signal, and it belongs on every resource response so the feed, a
  // collection's contents and the saved list all show it without a second query.
  //
  // `comments` is here for the same reason and not because anything reads the
  // bodies on this path — the count is what lets a resource page show "3 comments"
  // and prompt the discussion before anyone opens it. Discussion is public
  // content, so the count is public too.
  _count: { select: { savedResources: true, comments: true } },
} as const;

/**
 * The orderings a client may ask for.
 *
 * A single enum of **complete orderings** rather than a `sort` field plus an
 * `order` direction. Two parameters would allow states that mean nothing —
 * `sort=title&order=sideways` — and every one of them would need a rule. Naming
 * the whole ordering in one word makes every value something actually
 * implemented.
 *
 * Deliberately absent: relevance. It is not a `sort` value but the *absence* of
 * one, because it only means anything when there is a `q` to be relevant to, and
 * making it a value would mean defining a fourth state for `sort=relevance` with
 * no query. See {@link ResourceSort} in the service for how the two interact.
 *
 * Also absent: `saved`. See {@link resourceOrderBy} — that is a real constraint,
 * not an oversight.
 */
export enum ResourceSort {
  /** `createdAt` descending. The default posture of the site. */
  Newest = 'newest',
  /** `createdAt` ascending. */
  Oldest = 'oldest',
  /** `title` ascending, so a browse page can be walked alphabetically. */
  Title = 'title',
}

/** What a client gets when it asks for no particular ordering. */
export const DEFAULT_RESOURCE_SORT = ResourceSort.Newest;

/**
 * Newest first, with `id` as a tiebreaker. `createdAt` alone is not unique, and
 * without a total order a cursor can skip or repeat rows when several resources
 * share a timestamp — which they will, since `now()` has millisecond resolution.
 *
 * The tiebreaker is load-bearing in all three, and its **direction follows the
 * primary sort's**. `createdAt DESC, id ASC` is still a total order, but it reads
 * as a mistake, and on a title sort a descending tiebreak would scramble equal
 * titles between pages for no benefit.
 *
 * Every value here is a plain column ordering, which is why none of them needs a
 * different cursor: Prisma resolves `cursor: { id }` against the *current*
 * `orderBy`, so a client can page through a title-sorted list with exactly the
 * bare-id cursor it uses for newest-first. That property is what makes sorting
 * cheap here, and it is precisely what a computed ordering does not have — see the
 * relevance path in `resource-search.ts`.
 *
 * **`savedCount` and `commentCount` are deliberately not sortable.**
 * `docs/saved.md` declined them for the pagination half of the reason; the other
 * half is worse. The count *moves while somebody is paging*. Sort by `savedCount`
 * and one person saving a resource between page one and page two shifts every row
 * beneath it, so the cursor repeats some rows and skips others — silently, in a
 * way no test catches and no user can explain.
 *
 * A fixed top-N by saved count is a different question and a safe one, because
 * nothing is paging and so nothing can shift. That is why a "most saved" section
 * is fine and this is not.
 *
 * `accessType` is filterable but not sortable, and is unindexed. A four-value
 * column is one the planner often skips a btree for anyway, and the filter is
 * broad enough that it narrows a browsable set on its own.
 */
export const resourceOrderBy: Record<
  ResourceSort,
  Prisma.ResourceOrderByWithRelationInput[]
> = {
  [ResourceSort.Newest]: [{ createdAt: 'desc' }, { id: 'desc' }],
  [ResourceSort.Oldest]: [{ createdAt: 'asc' }, { id: 'asc' }],
  [ResourceSort.Title]: [{ title: 'asc' }, { id: 'asc' }],
};

/**
 * Most-saved first, as a relation count rather than a column.
 *
 * **Not a {@link ResourceSort}, and deliberately not reachable as one.** The
 * reason `resourceOrderBy` refuses to sort by `savedCount` is that the count moves
 * while somebody pages, which makes a bare-id cursor repeat and skip rows. A fixed
 * top-N has no cursor and no second page, so nothing can shift underneath it and
 * the objection does not apply.
 *
 * That is the whole difference, and it is a difference about *paging*, not about
 * the count being trustworthy. So this lives beside `resourceOrderBy` as a named
 * ordering rather than inside the enum: adding `MostSaved` to `ResourceSort` would
 * make `?sort=most-saved` valid on `GET /resources`, which **is** paginated, and
 * would quietly reintroduce the exact bug the enum's absence prevents.
 *
 * `id ASC` after the count is the tiebreaker, for the same reason every other
 * ordering here has one — a count is massively tied at zero and near-tied
 * elsewhere, and without a total order the result is whatever the join happened to
 * emit.
 *
 * Expressed as a relation count rather than the `_count.savedResources` select, so
 * Postgres computes it in the join. Prisma has no query-builder spelling of
 * `ORDER BY (SELECT COUNT(*) …)`, and fetching every row to sort in JavaScript is
 * unbounded, which this API never is.
 */
export const mostSavedOrderBy: Prisma.ResourceOrderByWithRelationInput[] = [
  { savedResources: { _count: 'desc' } },
  { id: 'asc' },
];

/** A resource row as read, before any redaction. */
export type ResourceWithRelations = Prisma.ResourceGetPayload<{
  include: typeof resourceInclude;
}>;

/** The contributor fields that never reach the response. */
type DerivedContributorFields =
  | 'username'
  | 'usernameLower'
  | 'isProfilePrivate';

/**
 * A resource as it is returned, once redaction and `profilePath` are applied.
 *
 * Distinct from {@link ResourceWithRelations} because the contributor has been
 * reshaped: the fields `profilePath` and the display name are derived from are
 * gone, replaced by a resolved `name` and a path. Everything else is the same.
 */
export type ResourceResponse = Omit<
  ResourceWithRelations,
  'contributor' | '_count'
> & {
  contributor:
    | (Omit<
        NonNullable<ResourceWithRelations['contributor']>,
        DerivedContributorFields
      > & { profilePath: string | null })
    | null;
  /**
   * How many people saved this resource. Public, unlike every other field here.
   *
   * A signal of interest rather than of quality — it says people came back for
   * it, not that it is the best one here — which is why it is on the public
   * response rather than hidden behind a signed-in read.
   */
  savedCount: number;
  /**
   * How many comments this resource has.
   *
   * Public and never redacted, on the same reasoning as `savedCount`: the
   * discussion is part of the public surface of the resource, and a page that
   * renders comments already has this number in hand.
   */
  commentCount: number;
};

/**
 * Withholds the contributor from a resource shared anonymously.
 *
 * Both the `contributor` object and the raw `contributorId` go, because
 * keeping the id would defeat the point: the same id appears on the person's
 * public contributions, so anyone comparing two posts could link the anonymous
 * one back to a name. Nothing is left to correlate on.
 *
 * The owner is not redacted from their own resource, which is what lets the
 * edit form load and pre-fill. A stranger presenting any token is still
 * redacted — only an exact `contributorId` match is let through.
 *
 * `isAnonymous` stays on the response so a client can tell an anonymous post
 * from one whose contributor was deleted. Those are different states and the
 * UI words them differently.
 */
export function redactAnonymous(
  resource: ResourceWithRelations,
  viewerId?: string,
): ResourceWithRelations {
  if (!resource.isAnonymous || resource.contributorId === viewerId) {
    return resource;
  }

  return { ...resource, contributor: null, contributorId: null };
}

/**
 * Resolves each contributor summary to the path a client should link to, or
 * `null` when it should not link at all.
 *
 * The decision is made here rather than in the client for the same reason
 * `redactAnonymous` lives here: a client that had to work it out from
 * `usernameLower` and `isProfilePrivate` would get it wrong somewhere, and a
 * wrong link points at a 404. One nullable string, and the only rule a frontend
 * needs is "render an anchor when it is not null".
 *
 * Null in three cases, all of them meaning "the name is still yours to read, but
 * there is nowhere to go from it":
 *
 * - The profile is private. This does not withdraw the name — the contributor
 *   chose to share these publicly and never asked to be unattributed — it only
 *   removes the destination. Whether a name appears is `isAnonymous`, and that
 *   is a separate decision the contributor made per resource.
 * - The account has never claimed a username. Possible for a pre-migration row,
 *   and for an owner who has not finished onboarding.
 * - There is no contributor at all, from `redactAnonymous` or a deleted account.
 */
export function withProfilePath(
  resource: ResourceWithRelations,
): ResourceResponse {
  // `_count` is a Prisma artefact, not part of the resource. It is flattened to
  // a single `savedCount` here for the same reason the contributor's raw fields
  // are replaced with a resolved `name` and `profilePath`: the shape a client
  // sees is shaped deliberately, rather than being whatever the query happened to
  // select.
  const { _count, ...fields } = resource;

  // Returned with no contributor forced in. A null contributor is a
  // *meaningful* value — the account was deleted, or the post is anonymous — and
  // it is already what `redactAnonymous` produced. Re-asserting it here would
  // mean a row that simply had no contributor key came back looking like a
  // redacted one.
  if (!resource.contributor)
    return {
      ...fields,
      savedCount: _count.savedResources,
      commentCount: _count.comments,
    } as ResourceResponse;

  const { username, usernameLower, isProfilePrivate, ...summary } =
    resource.contributor;

  return {
    ...fields,
    savedCount: _count.savedResources,
    commentCount: _count.comments,
    contributor: {
      ...summary,
      // A contributor with no Clerk name is shown by the handle they claimed,
      // in the case they chose. Never a placeholder: a byline reading "Shared by
      // Anonymous" would sit right next to one reading "Shared anonymously",
      // meaning two entirely different things.
      name: resolveDisplayName({ name: summary.name, username }),
      profilePath: resolveProfilePath({ usernameLower, isProfilePrivate }),
    },
  };
}

/**
 * Redacts and resolves in one step, which is the order every read wants and the
 * order that matters: `redactAnonymous` nulls the contributor, so running it
 * after `withProfilePath` would resolve a display name for a row that is about
 * to have its attribution withheld.
 */
export function toResourceResponse(
  resource: ResourceWithRelations,
  viewerId?: string,
): ResourceResponse {
  return withProfilePath(redactAnonymous(resource, viewerId));
}
