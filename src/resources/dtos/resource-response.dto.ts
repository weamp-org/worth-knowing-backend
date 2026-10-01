import { AccessType, ResourceType } from '../../generated/prisma/enums';

/** A tag as returned alongside a resource. */
export class TagSummaryDto {
  id: string;

  /** Display form as the contributor typed it
   * @example 'Machine Learning'
   */
  name: string;

  /** Normalized identity, safe to put in a URL once percent-encoded
   * @example 'machine-learning'
   */
  slug: string;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * The contributor. `null` when the contributor's account has been deleted —
 * the resource survives, the attribution does not — or when the contribution is
 * anonymous and the caller is not the contributor.
 */
export class ContributorSummaryDto {
  /** The Clerk user ID
   * @example 'user_2abc'
   */
  id: string;

  /**
   * The Clerk name, or failing that the handle they claimed here.
   *
   * Never a placeholder. Null cannot occur for a contributor in practice —
   * `/share` is gated on holding a handle, so the fallback always resolves.
   * @example 'Ada Lovelace'
   */
  name: string | null;

  imageUrl: string | null;

  /**
   * Where to link this name, computed by the server.
   *
   * `null` when there is nowhere to go: the profile is private, or the account
   * has not claimed a username yet. It is never `null` because the name should be
   * hidden — that is what a null `contributor` means, and it is a different
   * decision the contributor made per resource.
   *
   * Present as a resolved path rather than as the two fields it is derived from
   * so a client cannot get the rule wrong and link to a page that 404s. Render
   * an anchor when this is a string, plain text when it is null.
   * @example '/u/adal'
   */
  profilePath: string | null;
}

export class ResourceResponseDto {
  id: string;

  title: string;

  url: string;

  type: ResourceType;

  accessType: AccessType;

  why: string;

  createdAt: Date;
  updatedAt: Date;

  contributorId: string | null;
  contributor: ContributorSummaryDto | null;

  /**
   * Whether the contributor asked to be withheld. Both `contributor` and
   * `contributorId` come back null when this is true, unless the caller is the
   * contributor.
   *
   * Present so a client can tell an anonymous contribution apart from one whose
   * contributor was deleted — different states, worded differently.
   * @example true
   */
  isAnonymous: boolean;

  tags: TagSummaryDto[];

  /**
   * How many people saved this resource.
   *
   * Public, unlike every other field here. A signal of *interest* rather than of
   * quality — it says people came back for it, not that it is the best one here
   * — which is why it is not behind a signed-in read.
   *
   * Present on every resource response, so the feed, a collection's contents and
   * a person's saved list all show it without a second request.
   * @example 12
   */
  savedCount: number;
}

/** One page of `GET /api/v1/resources`. */
export class PaginatedResourcesResponseDto {
  items: ResourceResponseDto[];

  /** Pass back as `?cursor=` to get the next page. `null` on the last page.
   * @example 'Y2tpZGEyYjM0'
   */
  nextCursor: string | null;
}
