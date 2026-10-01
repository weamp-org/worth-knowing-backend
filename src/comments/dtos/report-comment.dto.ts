import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Upper bound on a report's reason. Matches the column.
 *
 * Kept well below a comment's own limit on purpose: a report is a complaint, and the
 * place to argue about the content is the thread it is about.
 */
export const REPORT_REASON_MAX_LENGTH = 500;

export class ReportCommentDto {
  /**
   * Why you think this should go, in your own words.
   *
   * Optional. An empty queue of optional free text is still a usable queue, and a
   * required reason is a dropdown somebody has to pick from before they can report
   * something they plainly know is wrong.
   *
   * Shown to admins only.
   * @example 'Links to a site that just served me malware.'
   */
  @IsOptional()
  @IsString()
  @MaxLength(REPORT_REASON_MAX_LENGTH)
  reason?: string;
}
