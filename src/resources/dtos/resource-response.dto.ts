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
 * the resource survives, the attribution does not.
 */
export class ContributorSummaryDto {
  /** The Clerk user ID
   * @example 'user_2abc'
   */
  id: string;

  name: string;

  imageUrl: string | null;
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

  tags: TagSummaryDto[];
}

/** One page of `GET /api/v1/resources`. */
export class PaginatedResourcesResponseDto {
  items: ResourceResponseDto[];

  /** Pass back as `?cursor=` to get the next page. `null` on the last page.
   * @example 'Y2tpZGEyYjM0'
   */
  nextCursor: string | null;
}
