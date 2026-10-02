import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { CommentReportReason } from '../../generated/prisma/enums';
import { REPORT_DETAIL_MAX_LENGTH } from '../../resources/dtos/report-resource.dto';

/**
 * The 500-character free-text bound, imported rather than restated.
 *
 * The two report DTOs carry the same limit for the same reason — a report is a
 * complaint, not a second contribution — and two copies of the number would be free
 * to drift.
 */
export { REPORT_DETAIL_MAX_LENGTH };

export class ReportCommentDto {
  /**
   * What is wrong with it.
   *
   * **Required**, because a queue of free text has to be read one report at a time
   * before a moderator can group anything. `OFF_TOPIC` is a judgement call rather than
   * a fault, and a moderator may reasonably leave it — which is why the categories are
   * separated by the *decision* they imply, not by severity.
   */
  @IsEnum(CommentReportReason)
  reason: CommentReportReason;

  /**
   * Anything a moderator should know. Optional.
   *
   * Shown to admins only. Not to the comment's author, and not to any reader.
   * @example 'Not about the resource at all.'
   */
  @IsOptional()
  @IsString()
  @MaxLength(REPORT_DETAIL_MAX_LENGTH)
  detail?: string;
}
