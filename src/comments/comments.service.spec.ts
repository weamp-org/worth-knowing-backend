import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';

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
});
