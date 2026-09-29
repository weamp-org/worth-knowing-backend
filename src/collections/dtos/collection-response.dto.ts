import { ResourceResponseDto } from '../../resources/dtos/resource-response.dto';

/** The owner, as returned alongside a collection. */
export class CollectionOwnerSummaryDto {
  /**
   * The Clerk name, or failing that the handle they claimed here.
   *
   * Never a placeholder, and never withheld. A collection is always attributed:
   * it is a statement by somebody about what they think is worth knowing, and
   * that is the same judgment the product asks for on a resource. Unlike a
   * contribution, a collection has no anonymous mode — the whole point of the
   * page is whose taste it is.
   * @example 'Ada Lovelace'
   */
  name: string | null;

  imageUrl: string | null;

  /**
   * Where to link this name, computed by the server.
   *
   * `null` when there is nowhere to go: the profile is private, or no username
   * has been claimed. Same rule as `ContributorSummaryDto.profilePath`, and for
   * the same reason — resolved here so no client has to reimplement it and get a
   * link to a 404 out of the other side.
   * @example '/u/adal'
   */
  profilePath: string | null;
}

export class CollectionResponseDto {
  id: string;

  /**
   * A short, human-readable name for the collection.
   * @example 'Read before starting research'
   */
  title: string;

  /**
   * Why these resources belong together, in the owner's own words. `null` when
   * the owner did not write one.
   * @example 'The four papers that made agent-based modelling click for me.'
   */
  description: string | null;

  /**
   * Whether the collection is hidden from everybody but its owner. A client
   * should treat a private collection it is not the owner of as unreachable —
   * the route answers 404 rather than 403, so there is nothing to render.
   * @example false
   */
  isPrivate: boolean;

  createdAt: Date;
  updatedAt: Date;

  /** The owner, or `null` if their account was deleted. */
  owner: CollectionOwnerSummaryDto | null;

  /**
   * How many resources the collection holds. Counted so a listing can show it
   * without loading the contents.
   * @example 12
   */
  resourceCount: number;

  /**
   * Whether the signed-in caller owns this collection.
   *
   * Decided by the backend, because the response carries no identifier a client
   * could compare against — the same rule that puts `isOwner` on a profile.
   * @example true
   */
  isOwner: boolean;
}

/** One collection in `GET /api/v1/collections/me`. */
export class CollectionSummaryDto extends CollectionResponseDto {
  /**
   * Whether this collection already holds the resource named by
   * `?resourceId=`.
   *
   * `false` for every row when the client did not send that parameter, and for a
   * request that did not name an existing resource. It is a convenience flag for
   * the picker, not a claim about anything: reading it as `true` when the
   * question was never asked is a bug the API shape invites, so only ask for it
   * when you have a resource in hand.
   * @example true
   */
  containsResource: boolean;
}

/** One page of `GET /api/v1/collections/me`. */
export class PaginatedCollectionsResponseDto {
  items: CollectionSummaryDto[];

  /** Pass back as `?cursor=` to get the next page. `null` on the last page.
   * @example 'Y2tpZGEyYjM0'
   */
  nextCursor: string | null;
}

/**
 * One page of `GET /api/v1/collections/:id/resources`.
 *
 * The items are resources, not collections, and are redacted exactly as they
 * would be on `GET /resources`: an anonymous contribution stays anonymous here,
 * so making a collection public does not deanonymize anything inside it.
 */
export class PaginatedCollectionResourcesResponseDto {
  items: ResourceResponseDto[];

  /** Pass back as `?cursor=` to get the next page. `null` on the last page.
   * @example 'Y2tpZGEyYjM0'
   */
  nextCursor: string | null;
}
