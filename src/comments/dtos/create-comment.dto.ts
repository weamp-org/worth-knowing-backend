import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Upper bound on a comment. Matches the column. */
export const COMMENT_BODY_MAX_LENGTH = 2000;

export class CreateCommentDto {
  /**
   * What you want to say about this resource.
   *
   * A comment that renders as nothing is worse than no comment at all: it takes up
   * a row in the thread, counts toward `commentCount`, and gives a reader nothing to
   * have reacted to. `@MinLength(1)` rejects `""` but not `"   "`, so the service
   * trims before storing and throws on a blank result.
   *
   * Markdown is not rendered. A link is still a link, so a bare URL is useful on
   * its own.
   * @example 'Chapter 14 is the one that made the whole argument land for me.'
   */
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_BODY_MAX_LENGTH)
  body: string;

  /**
   * The comment this one replies to, if any.
   *
   * Optional, and **one level only**. A reply to a reply is accepted by the
   * database — the column is nullable and carries no depth constraint — but the
   * service re-points it at that reply's own parent, so the rendered thread stays
   * one level deep no matter what is sent here.
   *
   * @example 'ckq8f2a1b0000abcdefghijkl'
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  parentId?: string;
}
