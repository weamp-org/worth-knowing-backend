import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { ResourceReportReason } from '../../generated/prisma/enums';

/** Upper bound on the free-text detail. Matches the column. */
export const REPORT_DETAIL_MAX_LENGTH = 500;

export class ReportResourceDto {
  /**
   * What is wrong with it.
   *
   * **Required**, and that is the whole reason a queue is workable: free text alone
   * means a moderator reads every report individually before being able to group them.
   * The category is what makes "12 spam, 3 broken links" legible at a glance.
   *
   * Not every reason implies removal. `BROKEN_LINK` and `WRONG_RESOURCE` are usually
   * a fix, and a `why` written carefully for a dead link is worth keeping — which is
   * why there is no `DUPLICATE` here either: two people sharing one link is this
   * product working.
   */
  @IsEnum(ResourceReportReason)
  reason: ResourceReportReason;

  /**
   * Anything a moderator should know. Optional.
   *
   * Split from `reason` on purpose. The category is required so the queue sorts; a
   * required wall of free text would be exactly the friction that stops somebody
   * reporting the thing they already know is wrong.
   *
   * Shown to admins only, and never to the contributor.
   * @example 'It 404s now, but the chapter structure is why I saved it.'
   */
  @IsOptional()
  @IsString()
  @MaxLength(REPORT_DETAIL_MAX_LENGTH)
  detail?: string;
}
