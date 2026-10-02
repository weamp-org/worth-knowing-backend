import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Upper bound on a report's reason. Matches the column. */
export const REPORT_REASON_MAX_LENGTH = 500;

export class ReportResourceDto {
  /**
   * Why you think this should go, in your own words.
   *
   * Optional, deliberately. A required reason is a dropdown somebody has to pick from
   * before they can report something they plainly know is wrong — a link that served
   * them malware does not need a category, it needs sending.
   *
   * Shown to admins only, and never to the contributor.
   * @example 'This link just installed something on my machine.'
   */
  @IsOptional()
  @IsString()
  @MaxLength(REPORT_REASON_MAX_LENGTH)
  reason?: string;
}
