import { NotificationType } from '../../generated/prisma/enums';

/**
 * Who did the thing. `null` when the account is gone — the client renders
 * "Someone" rather than dropping news the recipient is still owed.
 */
export class NotificationActorDto {
  /** The Clerk user ID
   * @example 'user_2abc'
   */
  id: string;

  /**
   * The Clerk name, or failing that the handle they claimed here.
   * @example 'Ada Lovelace'
   */
  name: string | null;

  imageUrl: string | null;

  /**
   * Where to link this name, computed by the server. `null` when the profile
   * is private or no username was claimed.
   * @example '/u/adal'
   */
  profilePath: string | null;
}

export class NotificationResourceDto {
  id: string;

  title: string;
}

export class NotificationCommentDto {
  id: string;

  body: string;
}

export class NotificationResponseDto {
  id: string;

  type: NotificationType;

  createdAt: Date;

  /** Null until read — the client words null as unread.
   * @example null
   */
  readAt: Date | null;

  actor: NotificationActorDto | null;

  resource: NotificationResourceDto;

  /** Null when the comment was deleted.
   * @example null
   */
  comment: NotificationCommentDto | null;
}

/** One page of `GET /api/v1/notifications`. */
export class PaginatedNotificationsResponseDto {
  items: NotificationResponseDto[];

  /** Pass back as `?cursor=` to get the next page. `null` on the last page.
   * @example 'Y2tpZGEyYjM0'
   */
  nextCursor: string | null;
}
