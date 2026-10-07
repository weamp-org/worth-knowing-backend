import { Prisma } from '../generated/prisma/client';
import type { ResourceReportReason } from '../generated/prisma/enums';

import { resourceInclude, toResourceResponse } from './resource-read';
import type { ResourceResponse } from './resource-read';

/**
 * The read shape for a resource report, and the transformations it applies.
 *
 * Split out of `resource-read.ts` rather than put there, because this shape is only
 * ever used by the admin queue and adding `reports` to the public `resourceInclude`
 * would put a report count on every resource response — which must never happen.
 * Nothing about a report is public, not even a count.
 */

/**
 * The public resource read, plus the report count.
 *
 * Spreading `resourceInclude` rather than restating it is the point: the reported
 * resource goes through the same `toResourceResponse` a reader's thread does, so
 * there is exactly one implementation of the anonymity and `profilePath` rules. The
 * extra `_count` field is read here and dropped there — `_count` never reaches a
 * response.
 */
export const reportResourceInclude = {
  ...resourceInclude,
  _count: {
    select: { ...resourceInclude._count.select, reports: true },
  },
} as const;

/**
 * Newest report first, then `reporterId`, then `resourceId`.
 *
 * All three columns are load-bearing: `createdAt` is not unique, and neither is
 * `reporterId` alone, so a keyset cursor over any prefix of this would skip or
 * repeat rows. Paired with
 * `ResourceReport_createdAt_reporterId_resourceId_idx`.
 */
export const resourceReportOrderBy = [
  { createdAt: 'desc' },
  { reporterId: 'desc' },
  { resourceId: 'desc' },
] satisfies Prisma.ResourceReportOrderByWithRelationInput[];

/** A resource report row as read, before any reshaping. */
export type ResourceReportWithResource = Prisma.ResourceReportGetPayload<{
  include: { resource: { include: typeof reportResourceInclude } };
}>;

/** A resource report as the admin queue returns it. */
export type ResourceReportResponse = {
  /** The composite primary key, `resourceId:reporterId`. Carries no meaning to read. */
  id: string;
  resource: ResourceResponse;
  reportCount: number;
  /** Required category — what makes the queue sortable. */
  reason: ResourceReportReason;
  /** Optional free text, flattened to an empty string rather than left null. */
  detail: string;
  createdAt: Date;
};

/**
 * Flattens a report row for the admin queue.
 *
 * The resource goes through `toResourceResponse` **with no viewer**, which means an
 * anonymously shared contribution comes back with its contributor withheld here too.
 * That is deliberate and is the whole point of routing this through the shared shaping
 * rather than selecting the fields directly: `isAnonymous` is a promise the
 * contributor made, and the person most likely to be tempted to break it is not a
 * stranger on the feed but a moderator with a queue in front of them. They do not
 * need the name to decide that a link is spam.
 *
 * `detail` is flattened to an empty string rather than left null: the column is
 * nullable because not every reporter says more than the category, but a null on the
 * response would make a client render a fallback for something that reads as a bug.
 * `reason` is required and passed through as-is.
 */
export function toResourceReportResponse(
  report: ResourceReportWithResource,
): ResourceReportResponse {
  return {
    id: `${report.resourceId}:${report.reporterId}`,
    resource: toResourceResponse(report.resource),
    reportCount: report.resource._count.reports,
    reason: report.reason,
    detail: report.detail ?? '',
    createdAt: report.createdAt,
  };
}
