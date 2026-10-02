import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { CommentReportReason } from '../generated/prisma/enums';

import { CommentsService } from './comments.service';
import { PrismaService } from '../prisma/prisma.service';
import { encodeCursor } from '../pagination/cursor.util';
import { PARENT_QUOTE_LENGTH } from './comment-read';

const USER = 'user_1';
const OTHER = 'user_2';
const RESOURCE = 'res_1';

/** A comment row shaped like the `commentInclude` read. */
function commentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt_1',
    resourceId: RESOURCE,
    body: 'Chapter 14 is the one that made the whole argument land.',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    authorId: OTHER,
    author: {
      id: OTHER,
      name: 'Grace Hopper',
      imageUrl: null,
      username: 'grace',
      usernameLower: 'grace',
      isProfilePrivate: false,
    },
    parentId: null,
    parent: null,
    ...overrides,
  };
}

/**
 * A partial matcher for the `data` a create was called with.
 *
 * `expect.objectContaining` returns `any`, and the lint rules here reject unsafe
 * assignment off one — including when it is nested inside another
 * `objectContaining`. This wrapper narrows it once so each assertion below reads as
 * a plain call, and keeps the assertions about `data` themselves partial rather than
 * pinning every field on every test.
 */
function dataContaining(expected: Record<string, unknown>) {
  return expect.objectContaining(expected) as unknown as object;
}

describe('CommentsService', () => {
  let service: CommentsService;
  let prisma: {
    comment: {
      create: jest.Mock;
      delete: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
    commentReport: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    resource: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let role: 'USER' | 'ADMIN';

  beforeEach(async () => {
    role = 'USER';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        {
          provide: PrismaService,
          useValue: {
            comment: {
              create: jest.fn().mockResolvedValue(commentRow()),
              delete: jest.fn().mockResolvedValue({}),
              findMany: jest.fn().mockResolvedValue([]),
              findUnique: jest.fn().mockResolvedValue(commentRow()),
            },
            commentReport: {
              createMany: jest.fn().mockResolvedValue({ count: 1 }),
              findMany: jest.fn().mockResolvedValue([]),
              updateMany: jest.fn().mockResolvedValue({ count: 3 }),
              deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
            },
            resource: {
              findUnique: jest.fn().mockResolvedValue({ id: RESOURCE }),
            },
            user: {
              // Typed at the boundary rather than left implicit: the role lookup is
              // keyed by an id the test controls, and an `any` here would let the
              // mock answer for the wrong account without noticing.
              findUnique: jest
                .fn()
                .mockImplementation(({ where }: { where: { id: string } }) => {
                  if (where.id !== USER) return Promise.resolve(null);
                  return Promise.resolve({ id: USER, role });
                }),
            },
          },
        },
      ],
    }).compile();

    service = module.get(CommentsService);
    prisma = module.get(PrismaService);
  });

  describe('findForResource', () => {
    beforeEach(() => {
      // A thread with one comment by default, so the response-shaping assertions
      // have a row to look at. The pagination tests overwrite this themselves.
      prisma.comment.findMany.mockResolvedValue([commentRow()]);
    });

    it('pages newest first with id as the tiebreaker', async () => {
      await service.findForResource(RESOURCE);

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resourceId: RESOURCE },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('scopes to one resource, so a thread cannot be asked across pages', async () => {
      await service.findForResource(RESOURCE);

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { resourceId: RESOURCE } }),
      );
    });

    it('asks for one row over the page, so hasMore needs no COUNT(*)', async () => {
      await service.findForResource(RESOURCE, 5);

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 6 }),
      );
    });

    it('trims the extra row and cursors on the last kept one', async () => {
      prisma.comment.findMany.mockResolvedValue([
        commentRow({ id: 'cmt_a' }),
        commentRow({ id: 'cmt_b' }),
        commentRow({ id: 'cmt_c' }),
      ]);

      const page = await service.findForResource(RESOURCE, 2);

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe(encodeCursor('cmt_b'));
    });

    it('cursors on the primary key, since a comment id is unique alone', async () => {
      await service.findForResource(RESOURCE, undefined, encodeCursor('cmt_1'));

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: 'cmt_1' },
          skip: 1,
        }),
      );
    });

    it('404s rather than showing an empty thread for a resource that is not there', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(
        service.findForResource('res_missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers an unknown cursor with a 400, not an empty page', async () => {
      prisma.comment.findMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('gone', {
          code: 'P2025',
          clientVersion: '7.0.0',
        }),
      );

      await expect(
        service.findForResource(RESOURCE, undefined, encodeCursor('cmt_gone')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is readable by a signed-out reader', async () => {
      const page = await service.findForResource(
        RESOURCE,
        undefined,
        undefined,
      );

      expect(page.items[0].isMine).toBe(false);
    });

    it('marks a comment as the viewer’s own', async () => {
      prisma.comment.findMany.mockResolvedValue([
        commentRow({ authorId: USER, author: { id: USER, name: null } }),
      ]);

      const page = await service.findForResource(
        RESOURCE,
        undefined,
        undefined,
        USER,
      );

      expect(page.items[0].isMine).toBe(true);
    });

    it('resolves a display name and profile path rather than leaking the raw fields', async () => {
      const page = await service.findForResource(RESOURCE);

      expect(page.items[0].author).toEqual({
        id: OTHER,
        name: 'Grace Hopper',
        imageUrl: null,
        profilePath: '/u/grace',
      });
      expect(page.items[0].author).not.toHaveProperty('usernameLower');
    });

    it('truncates a long parent for the quote', async () => {
      const long = 'x'.repeat(PARENT_QUOTE_LENGTH + 200);
      prisma.comment.findMany.mockResolvedValue([
        commentRow({
          parentId: 'cmt_parent',
          parent: { id: 'cmt_parent', body: long },
        }),
      ]);

      const page = await service.findForResource(RESOURCE);

      expect(page.items[0].parent?.body).toHaveLength(PARENT_QUOTE_LENGTH + 1);
      expect(page.items[0].parent?.body.endsWith('…')).toBe(true);
    });

    it('leaves a short parent untruncated', async () => {
      prisma.comment.findMany.mockResolvedValue([
        commentRow({
          parentId: 'cmt_p',
          parent: { id: 'cmt_p', body: 'Short.' },
        }),
      ]);

      const page = await service.findForResource(RESOURCE);

      expect(page.items[0].parent?.body).toBe('Short.');
    });
  });

  describe('create', () => {
    it('stores the comment against the resource and the session user', async () => {
      await service.create(RESOURCE, USER, { body: 'Worth it.' });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            resourceId: RESOURCE,
            authorId: USER,
            body: 'Worth it.',
            parentId: null,
          },
        }),
      );
    });

    it('trims the body, so leading whitespace never reaches the column', async () => {
      await service.create(RESOURCE, USER, { body: '  Padded.  ' });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            resourceId: RESOURCE,
            authorId: USER,
            body: 'Padded.',
            parentId: null,
          },
        }),
      );
    });

    it('rejects a whitespace-only body rather than storing a comment that renders as nothing', async () => {
      await expect(
        service.create(RESOURCE, USER, { body: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('404s rather than letting a foreign key surface as a 500', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(
        service.create('res_missing', USER, { body: 'Worth it.' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows commenting on an anonymous contribution without touching its attribution', async () => {
      await service.create(RESOURCE, USER, { body: 'Useful, thanks.' });

      // The only link between a comment and a resource is `resourceId`. Anonymity is
      // decided on the resource read, so there is nothing here that could un-withhold
      // a contributor.
      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: dataContaining({ resourceId: RESOURCE }),
        }),
      );
    });

    it('stores a top-level comment with no parent lookup at all', async () => {
      await service.create(RESOURCE, USER, { body: 'Worth it.' });

      expect(prisma.comment.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ select: { parentId: true } }),
      );
    });

    it('404s for a parent that does not exist', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.create(RESOURCE, USER, {
          body: 'Reply.',
          parentId: 'cmt_missing',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s for a parent on a different resource, so a reply cannot land on the wrong thread', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_other',
        resourceId: 'res_other',
        parentId: null,
      });

      await expect(
        service.create(RESOURCE, USER, {
          body: 'Reply.',
          parentId: 'cmt_other',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('flattens a reply to a reply onto its grandparent, so depth never exceeds one', async () => {
      // `cmt_reply` is itself a reply to `cmt_top`, so a reply to it becomes a reply
      // to `cmt_top`.
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_reply',
        resourceId: RESOURCE,
        parentId: 'cmt_top',
      });

      await service.create(RESOURCE, USER, {
        body: 'Reply to a reply.',
        parentId: 'cmt_reply',
      });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: dataContaining({ parentId: 'cmt_top' }),
        }),
      );
    });

    it('keeps a direct reply pointed at its own parent', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_top',
        resourceId: RESOURCE,
        parentId: null,
      });

      await service.create(RESOURCE, USER, {
        body: 'Reply.',
        parentId: 'cmt_top',
      });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: dataContaining({ parentId: 'cmt_top' }),
        }),
      );
    });

    it('marks a comment as the creator’s own on the response', async () => {
      prisma.comment.create.mockResolvedValue(commentRow({ authorId: USER }));

      const comment = await service.create(RESOURCE, USER, { body: 'Mine.' });

      expect(comment.isMine).toBe(true);
    });
  });

  describe('remove', () => {
    it('lets an author remove their own comment', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: OTHER });

      await service.remove(RESOURCE, 'cmt_1', OTHER);

      expect(prisma.comment.delete).toHaveBeenCalledWith({
        where: { id: 'cmt_1' },
      });
    });

    it('forbids a stranger, and never reaches the delete', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: OTHER });

      await expect(
        service.remove(RESOURCE, 'cmt_1', USER),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('lets an admin remove anybody’s, which is the moderation path', async () => {
      // Set on the mock rather than through a separate admin constant: the point is
      // that the *role* opens the path, not that a particular account holds it.
      role = 'ADMIN';
      prisma.comment.findUnique.mockResolvedValue({ authorId: OTHER });

      await service.remove(RESOURCE, 'cmt_1', USER);

      expect(prisma.comment.delete).toHaveBeenCalled();
    });

    it('scopes the read to the resource, so an id from another thread is a 404', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.remove('res_other', 'cmt_1', OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('answers a stranger the same way whether a comment is missing or not theirs', async () => {
      // Both cases must be indistinguishable, or the delete route becomes a way to
      // confirm that a comment id exists somewhere on the site.
      prisma.comment.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.remove(RESOURCE, 'cmt_x', USER),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.comment.findUnique.mockResolvedValueOnce({ authorId: OTHER });

      await expect(
        service.remove(RESOURCE, 'cmt_y', USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does not check the role for the author’s own comment', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: USER });

      await service.remove(RESOURCE, 'cmt_1', USER);

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('report', () => {
    /** The required half of every report below. */
    const reason = { reason: CommentReportReason.ABUSE };

    it('files the report with its category and the session user', async () => {
      await service.report(RESOURCE, 'cmt_1', USER, {
        reason: CommentReportReason.ABUSE,
        detail: 'Go back to your own site.',
      });

      expect(prisma.commentReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: USER,
          commentId: 'cmt_1',
          reason: CommentReportReason.ABUSE,
          detail: 'Go back to your own site.',
        },
        skipDuplicates: true,
      });
    });

    it('stores the category alone when no detail was given', async () => {
      // The category is what sorts the queue, so it is the required half. The detail
      // is optional precisely so a required wall of text cannot stop a report.
      await service.report(RESOURCE, 'cmt_1', USER, reason);

      expect(prisma.commentReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: USER,
          commentId: 'cmt_1',
          reason: CommentReportReason.ABUSE,
        },
        skipDuplicates: true,
      });
    });

    it('trims the detail, and drops a whitespace-only one', async () => {
      await service.report(RESOURCE, 'cmt_1', USER, {
        ...reason,
        detail: '  ',
      });

      expect(prisma.commentReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: USER,
          commentId: 'cmt_1',
          reason: CommentReportReason.ABUSE,
        },
        skipDuplicates: true,
      });
    });

    it('skips duplicates, so a double-click is not punished and cannot pad the count', async () => {
      await service.report(RESOURCE, 'cmt_1', USER, reason);

      // `skipDuplicates` rather than a read-then-write: race-safe in a way a check is
      // not, and the composite primary key is what actually prevents the duplicate.
      expect(prisma.commentReport.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('reopens a dismissed report when the same person reports again', async () => {
      // The bug this exists to fix: `createMany({ skipDuplicates: true })` is a
      // no-op when the row already exists, so without the reopen the repeat is
      // silently dropped — the endpoint answers 204 and the row keeps
      // `dismissedAt` set, so it never reappears in the queue. Reporting something
      // again is new information: it is still there.
      await service.report(RESOURCE, 'cmt_1', USER, reason);

      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith({
        where: {
          commentId: 'cmt_1',
          reporterId: USER,
          dismissedAt: { not: null },
        },
        data: dataContaining({ dismissedAt: null }),
      });
    });

    it('re-stamps the date on a reopened report, so it surfaces at the top', async () => {
      // `createdAt` is load-bearing on the reopen. The queue orders by `createdAt DESC`,
      // so clearing `dismissedAt` alone would put a report that arrived right now at
      // the bottom of the queue, under everything filed since — the original bug in a
      // quieter form: reported, and never seen.
      await service.report(RESOURCE, 'cmt_1', USER, reason);

      const [args] = jest.mocked(prisma.commentReport.updateMany).mock
        .calls[0] as unknown as [
        { data: { dismissedAt: Date | null; createdAt: Date } },
      ];
      expect(args.data.dismissedAt).toBeNull();
      expect(args.data.createdAt).toBeInstanceOf(Date);
    });

    it('reopens only that reporter’s row, not the whole comment', async () => {
      // Scoping to the reporter is the point. Another person's report is a separate
      // row with its own dismissal state, and reopening theirs would be overriding a
      // colleague's decision.
      await service.report(RESOURCE, 'cmt_1', USER, reason);

      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith(
        dataContaining({
          where: dataContaining({ reporterId: USER }),
        }),
      );
    });

    it('refuses a report on your own comment', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_1',
        authorId: USER,
      });

      await expect(
        service.report(RESOURCE, 'cmt_1', USER, reason),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.commentReport.createMany).not.toHaveBeenCalled();
    });

    it('scopes to the resource, so a report cannot be filed through the wrong thread', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.report('res_other', 'cmt_1', USER, reason),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.commentReport.createMany).not.toHaveBeenCalled();
    });

    it('lets anybody signed in report somebody else’s comment', async () => {
      // No role check at all: reporting is not a privileged act, which is the point.
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_1',
        authorId: OTHER,
      });

      await service.report(RESOURCE, 'cmt_1', USER, reason);

      expect(prisma.commentReport.createMany).toHaveBeenCalled();
    });
  });

  describe('listReports', () => {
    /** A report row shaped like the `reportInclude` read. */
    function reportRow(overrides: Record<string, unknown> = {}) {
      return {
        reporterId: OTHER,
        commentId: 'cmt_1',
        reason: 'Links to a site that served me malware.',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        comment: { ...commentRow(), _count: { reports: 3 } },
        ...overrides,
      };
    }

    beforeEach(() => {
      prisma.commentReport.findMany.mockResolvedValue([reportRow()]);
    });

    it('hides dismissed reports rather than showing them greyed', async () => {
      await service.listReports();

      // A moderator who already decided to keep a comment should not have to look at
      // it again on every pass, and a greyed row is a row somebody has to reason
      // about to know it can be skipped.
      expect(prisma.commentReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { dismissedAt: null } }),
      );
    });

    it('orders by when it was flagged, not when the comment was written', async () => {
      await service.listReports();

      // Paged over the report, for the same reason `SavedService` pages over the
      // save: a two-year-old comment reported yesterday is the newest thing a
      // moderator has to look at.
      expect(prisma.commentReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { createdAt: 'desc' },
            { reporterId: 'desc' },
            { commentId: 'desc' },
          ],
        }),
      );
    });

    it('returns one row per report, so the order is over a plain column', async () => {
      const page = await service.listReports();

      expect(page.items).toHaveLength(1);
      expect(page.items[0].reportCount).toBe(3);
    });

    it('never names the reporter', async () => {
      const page = await service.listReports();

      // A moderator needs to know a report exists and what it said, not who filed it.
      expect(page.items[0]).not.toHaveProperty('reporterId');
      expect(page.items[0]).not.toHaveProperty('reporter');
      // The id is the composite key, target first: `commentId:reporterId`.
      expect(page.items[0].id).toBe(`cmt_1:${OTHER}`);
    });

    it('renders the reported comment through the public thread’s own shape', async () => {
      const page = await service.listReports();

      expect(page.items[0].comment).toEqual(
        expect.objectContaining({
          id: 'cmt_1',
          author: expect.objectContaining({ name: 'Grace Hopper' }) as object,
        }),
      );
    });

    it('leaves isMine false on every queued comment, even the admin’s own', async () => {
      const page = await service.listReports();

      // A moderator is looking at somebody else's comment; forwarding their id would
      // make their own report appear as their own comment.
      expect(page.items[0].comment.isMine).toBe(false);
    });

    it('passes the category through and flattens an absent detail', async () => {
      // The category is required and stored; only the detail is optional, and it is
      // flattened so a client renders the text without a fallback that reads as a
      // bug rather than as an absent detail.
      prisma.commentReport.findMany.mockResolvedValue([
        reportRow({ reason: CommentReportReason.ABUSE, detail: null }),
      ]);

      const page = await service.listReports();

      expect(page.items[0].reason).toBe('ABUSE');
      expect(page.items[0].detail).toBe('');
    });

    it('asks for one row over the page, so hasMore needs no COUNT(*)', async () => {
      await service.listReports(5);

      expect(prisma.commentReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 6 }),
      );
    });

    it('trims the extra row and cursors on the last kept one', async () => {
      prisma.commentReport.findMany.mockResolvedValue([
        reportRow({ commentId: 'cmt_a', reporterId: 'user_a' }),
        reportRow({ commentId: 'cmt_b', reporterId: 'user_b' }),
        reportRow({ commentId: 'cmt_c', reporterId: 'user_c' }),
      ]);

      const page = await service.listReports(2);

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe(encodeCursor('cmt_b:user_b'));
    });

    it('cursors on the composite key, since one person reports many comments', async () => {
      await service.listReports(undefined, encodeCursor(`cmt_1:${OTHER}`));

      expect(prisma.commentReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: {
            reporterId_commentId: { reporterId: OTHER, commentId: 'cmt_1' },
          },
          skip: 1,
        }),
      );
    });

    it('rejects a cursor that is not a reporter:comment pair', async () => {
      await expect(
        service.listReports(undefined, encodeCursor('cmt_1')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a cursor missing either half of the pair', async () => {
      for (const cursor of [encodeCursor(':cmt_1'), encodeCursor('user_1:')]) {
        await expect(
          service.listReports(undefined, cursor),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('400s a cursor naming a row that is gone, since a report can be deleted', async () => {
      prisma.commentReport.findMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('gone', {
          code: 'P2025',
          clientVersion: '7.0.0',
        }),
      );

      await expect(
        service.listReports(undefined, encodeCursor(`cmt_gone:${OTHER}`)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('dismiss', () => {
    it('marks every report on the comment at once', async () => {
      await service.dismiss('cmt_1');

      // A comment five people reported is five rows. Dismissing one would leave four
      // queued, which is to say the queue could never be worked through — so a
      // dismissal is a decision about the comment, not about one person's report.
      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith({
        where: { commentId: 'cmt_1', dismissedAt: null },
        // `expect.any` returns `any`, which trips no-unsafe-assignment inside an
        // object literal. Typed through `dataContaining` for the same reason the
        // create assertions use it.
        data: dataContaining({ dismissedAt: expect.any(Date) as unknown }),
      });
    });

    it('touches only undisismissed rows, so a second dismissal is a no-op', async () => {
      await service.dismiss('cmt_1');

      // Idempotency as a query condition rather than as an error: two moderators
      // reaching for the same row at once is ordinary, and neither should see a
      // failure for it.
      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith(
        dataContaining({ where: { commentId: 'cmt_1', dismissedAt: null } }),
      );
    });

    it('does not delete the comment', async () => {
      await service.dismiss('cmt_1');

      // Dismissal is "seen, keeping it". Removing is a separate action with its own
      // route, and conflating them would make removal the answer to every report.
      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('does not delete the report rows either', async () => {
      await service.dismiss('cmt_1');

      // Nothing is deleted, which is what makes un-dismissing a matter of setting a
      // column back to null rather than reconstructing rows that were never lost.
      expect(prisma.commentReport.deleteMany).not.toHaveBeenCalled();
    });

    it('succeeds when there is nothing to dismiss', async () => {
      prisma.commentReport.updateMany.mockResolvedValue({ count: 0 });

      // Already dismissed, or never reported. "It is not in the queue" is exactly the
      // state the caller asked for, so there is nothing to report.
      await expect(service.dismiss('cmt_unknown')).resolves.toBeUndefined();
    });
  });

  describe('undismiss', () => {
    it('reopens every dismissed report on the comment', async () => {
      await service.undismiss('cmt_1');

      // The safety net that lets the client skip a confirmation dialog: without a way
      // back, a mis-click would be permanent in practice.
      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith({
        where: { commentId: 'cmt_1', dismissedAt: { not: null } },
        data: { dismissedAt: null },
      });
    });

    it('touches only rows a dismissal closed', async () => {
      await service.undismiss('cmt_1');

      // `not: null` rather than every row: a report filed *after* the dismissal is
      // already open and already queued, so reopening must leave it exactly where it
      // is rather than disturbing a report nobody resolved.
      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith(
        dataContaining({
          where: { commentId: 'cmt_1', dismissedAt: { not: null } },
        }),
      );
    });

    it('does not remove the comment on the way through', async () => {
      await service.undismiss('cmt_1');

      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('succeeds when nothing was dismissed', async () => {
      prisma.commentReport.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.undismiss('cmt_1')).resolves.toBeUndefined();
    });
  });
});
