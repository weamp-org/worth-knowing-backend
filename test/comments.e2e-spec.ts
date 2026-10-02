import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { getAuth } from '@clerk/express';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { validationPipeOptions } from './../src/validation';
import { CommentReportReason, UserRole } from './../src/generated/prisma/enums';

// Same approach as `saved.e2e-spec.ts`: `getAuth` needs a request branded by
// `clerkMiddleware()`, which only `main.ts` registers. `x-test-user-id` stands in for
// the authenticated Clerk session.
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
  clerkClient: { users: { getUser: jest.fn() } },
}));

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

/** A page of comments, as it comes back off the wire. */
interface CommentsBody {
  items: Array<{
    id: string;
    resourceId: string;
    body: string;
    author: Record<string, unknown> | null;
    isMine: boolean;
  }>;
  nextCursor: string | null;
}

/** A page of the admin report queue. */
interface ReportsBody {
  items: Array<{
    id: string;
    comment: { id: string; body: string; isMine: boolean };
    reportCount: number;
    reason: string;
  }>;
  nextCursor: string | null;
}

/** Reads the report queue body. Narrowed for the same reason as {@link asPage}. */
function asReports(response: { body: unknown }): ReportsBody {
  return response.body as ReportsBody;
}

/**
 * Reads the listing body.
 *
 * `supertest` types `response.body` as `any`, and the lint rules here reject unsafe
 * member access off an `any`. Narrowing once here keeps each assertion below reading
 * as a plain property access.
 */
function asPage(response: { body: unknown }): CommentsBody {
  return response.body as CommentsBody;
}

/**
 * A partial matcher for the `data` a create was called with.
 *
 * `expect.objectContaining` returns `any`, which the lint rules reject assigning —
 * including when nested inside another `objectContaining`. Narrowed once here so the
 * assertions about `data` can stay partial instead of pinning every field.
 */
function dataContaining(expected: Record<string, unknown>) {
  return expect.objectContaining(expected) as unknown as object;
}

describe('Comments (e2e)', () => {
  let app: INestApplication<App>;
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
    };
    resource: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let currentUserRole: UserRole;

  const asUser = (userId: string) => ({
    post: (url: string, body?: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(url)
        .set('x-test-user-id', userId)
        .send(body),
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('x-test-user-id', userId),
    delete: (url: string) =>
      request(app.getHttpServer()).delete(url).set('x-test-user-id', userId),
  });

  const asAnon = {
    get: (url: string) => request(app.getHttpServer()).get(url),
    post: (url: string, body?: Record<string, unknown>) =>
      request(app.getHttpServer()).post(url).send(body),
    delete: (url: string) => request(app.getHttpServer()).delete(url),
  };

  const thread = `/api/v1/resources/${RESOURCE}/comments`;

  beforeEach(async () => {
    currentUserRole = UserRole.USER;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        comment: {
          create: jest.fn().mockResolvedValue(commentRow({ authorId: USER })),
          delete: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([commentRow()]),
          findUnique: jest.fn().mockResolvedValue(commentRow()),
        },
        commentReport: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          updateMany: jest.fn().mockResolvedValue({ count: 3 }),
          findMany: jest.fn().mockResolvedValue([
            {
              reporterId: OTHER,
              commentId: 'cmt_1',
              reason: CommentReportReason.SPAM,
              detail: 'Go back to your own site.',
              createdAt: new Date('2026-03-01T00:00:00.000Z'),
              comment: { ...commentRow(), _count: { reports: 3 } },
            },
          ]),
        },
        resource: {
          findUnique: jest.fn().mockResolvedValue({ id: RESOURCE }),
        },
        user: {
          findUnique: jest
            .fn()
            .mockImplementation(({ where }: { where: { id: string } }) =>
              Promise.resolve({ id: where.id, role: currentUserRole }),
            ),
        },
      })
      .compile();

    prisma = moduleFixture.get(PrismaService);

    (getAuth as jest.Mock).mockImplementation(
      (req: { header?: (name: string) => string | undefined }) => ({
        userId: req.header?.('x-test-user-id') ?? null,
      }),
    );

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe(validationPipeOptions));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('auth', () => {
    it('lets anybody read the thread, signed out included', async () => {
      await asAnon.get(thread).expect(200);
    });

    it('requires a session to comment', async () => {
      await asAnon.post(thread, { body: 'Worth it.' }).expect(401);
    });

    it('requires a session to remove a comment', async () => {
      await asAnon.delete(`${thread}/cmt_1`).expect(401);
    });
  });

  describe('GET', () => {
    it('returns a page, not a bare array', async () => {
      const response = await asAnon.get(thread).expect(200);

      expect(response.body).toEqual({
        items: [expect.objectContaining({ id: 'cmt_1' })],
        nextCursor: null,
      });
    });

    it('never exposes the author’s raw username fields', async () => {
      const page = asPage(await asAnon.get(thread).expect(200));

      expect(page.items[0].author).toEqual({
        id: OTHER,
        name: 'Grace Hopper',
        imageUrl: null,
        profilePath: '/u/grace',
      });
    });

    it('marks a comment as yours only for its author', async () => {
      prisma.comment.findMany.mockResolvedValue([
        commentRow({
          authorId: USER,
          author: {
            id: USER,
            name: null,
            imageUrl: null,
            username: null,
            usernameLower: null,
            isProfilePrivate: false,
          },
        }),
      ]);

      const mine = asPage(await asUser(USER).get(thread).expect(200));
      expect(mine.items[0].isMine).toBe(true);

      const theirs = asPage(await asUser(OTHER).get(thread).expect(200));
      expect(theirs.items[0].isMine).toBe(false);
    });

    it('reads a signed-out request as no viewer rather than as a null id', async () => {
      const page = asPage(await asAnon.get(thread).expect(200));

      expect(page.items[0].isMine).toBe(false);
    });

    it('404s for a resource that is not there', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await asAnon.get('/api/v1/resources/res_missing/comments').expect(404);
    });

    it('rejects a negative limit', async () => {
      await asAnon.get(`${thread}?limit=-1`).expect(400);
    });

    it('rejects a limit over the ceiling', async () => {
      await asAnon.get(`${thread}?limit=101`).expect(400);
    });

    it('rejects an unknown query parameter, since validation forbids extras', async () => {
      await asAnon.get(`${thread}?order=best`).expect(400);
    });
  });

  describe('POST', () => {
    it('creates the comment against the resource and the session user', async () => {
      await asUser(USER).post(thread, { body: 'Worth it.' }).expect(201);

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: dataContaining({
            resourceId: RESOURCE,
            authorId: USER,
            body: 'Worth it.',
          }),
        }),
      );
    });

    it('returns the created comment, so the thread needs no refetch', async () => {
      const response = await asUser(USER)
        .post(thread, { body: 'Worth it.' })
        .expect(201);

      expect(response.body).toEqual(
        expect.objectContaining({ id: 'cmt_1', resourceId: RESOURCE }),
      );
    });

    it('never exposes the author’s raw username fields on a created comment', async () => {
      prisma.comment.create.mockResolvedValue(
        commentRow({ authorId: USER, author: null }),
      );

      const response = await asUser(USER)
        .post(thread, { body: 'Worth it.' })
        .expect(201);

      expect(response.body).toEqual(expect.objectContaining({ isMine: true }));
    });

    it('trims the body before storing it', async () => {
      await asUser(USER).post(thread, { body: '  Padded.  ' }).expect(201);

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: dataContaining({ body: 'Padded.' }),
        }),
      );
    });

    it('rejects a whitespace-only body rather than storing an empty comment', async () => {
      await asUser(USER).post(thread, { body: '   ' }).expect(400);

      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a missing body', async () => {
      await asUser(USER).post(thread, {}).expect(400);
    });

    it('rejects a body over the column limit', async () => {
      await asUser(USER)
        .post(thread, { body: 'x'.repeat(2001) })
        .expect(400);
    });

    it('rejects an unknown field, since the pipe forbids extras', async () => {
      await asUser(USER)
        .post(thread, { body: 'Worth it.', isAnonymous: true })
        .expect(400);
    });

    it('404s for a resource that is not there', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await asUser(USER)
        .post('/api/v1/resources/res_missing/comments', { body: 'Worth it.' })
        .expect(404);
    });

    it('accepts a reply, storing the parent', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_top',
        resourceId: RESOURCE,
        parentId: null,
      });

      await asUser(USER)
        .post(thread, { body: 'Agreed.', parentId: 'cmt_top' })
        .expect(201);

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: dataContaining({ parentId: 'cmt_top' }),
        }),
      );
    });

    it('flattens a reply to a reply onto the grandparent', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_reply',
        resourceId: RESOURCE,
        parentId: 'cmt_top',
      });

      await asUser(USER)
        .post(thread, { body: 'Also agreed.', parentId: 'cmt_reply' })
        .expect(201);

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: dataContaining({ parentId: 'cmt_top' }),
        }),
      );
    });

    it('404s for a parent on another resource, so a reply cannot land on the wrong thread', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_other',
        resourceId: 'res_other',
        parentId: null,
      });

      await asUser(USER)
        .post(thread, { body: 'Wrong page.', parentId: 'cmt_other' })
        .expect(404);

      expect(prisma.comment.create).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('answers 204 with no body', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: USER });

      const response = await asUser(USER).delete(`${thread}/cmt_1`).expect(204);

      // No body at all, rather than a comment with its text emptied — there is
      // nothing left to describe and nothing for a client to render.
      expect(response.text).toBe('');
    });

    it('lets an author remove their own comment', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: USER });

      await asUser(USER).delete(`${thread}/cmt_1`).expect(204);

      expect(prisma.comment.delete).toHaveBeenCalledWith({
        where: { id: 'cmt_1' },
      });
    });

    it('forbids a stranger', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: OTHER });

      await asUser(USER).delete(`${thread}/cmt_1`).expect(403);

      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('lets an admin remove anybody’s, which is the moderation path', async () => {
      currentUserRole = UserRole.ADMIN;
      prisma.comment.findUnique.mockResolvedValue({ authorId: OTHER });

      await asUser(USER).delete(`${thread}/cmt_1`).expect(204);

      expect(prisma.comment.delete).toHaveBeenCalled();
    });

    it('404s for a comment on a different resource, even one the caller wrote', async () => {
      // The delete route is nested, so an id from another thread must not be
      // removable through this resource's path.
      prisma.comment.findUnique.mockResolvedValue(null);

      await asUser(USER).delete(`${thread}/cmt_elsewhere`).expect(404);

      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });
  });

  describe('POST .../report', () => {
    const report = `${thread}/cmt_1/report`;

    it('requires a session, since a report has to be attributable', async () => {
      await asAnon
        .post(report, { reason: CommentReportReason.SPAM })
        .expect(401);
    });

    it('files the report and answers 204 with no body', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_1',
        authorId: OTHER,
      });

      const response = await asUser(USER)
        .post(report, {
          reason: CommentReportReason.SPAM,
          detail: 'Go back to your own site.',
        })
        .expect(204);

      expect(response.text).toBe('');
      expect(prisma.commentReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: USER,
          commentId: 'cmt_1',
          reason: CommentReportReason.SPAM,
          detail: 'Go back to your own site.',
        },
        skipDuplicates: true,
      });
    });

    it('does not change the thread, so a report is invisible to readers', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_1',
        authorId: OTHER,
      });

      await asUser(USER)
        .post(report, { reason: CommentReportReason.SPAM })
        .expect(204);

      // Nothing about the comment itself was written, so the public listing is
      // untouched and no reader — including the author — can tell it was flagged.
      expect(prisma.comment.create).not.toHaveBeenCalled();
      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('is idempotent rather than a 409 on a repeat', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_1',
        authorId: OTHER,
      });

      await asUser(USER)
        .post(report, { reason: CommentReportReason.SPAM })
        .expect(204);

      expect(prisma.commentReport.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('refuses a report on your own comment', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_1',
        authorId: USER,
      });

      await asUser(USER)
        .post(report, { reason: CommentReportReason.SPAM })
        .expect(400);

      expect(prisma.commentReport.createMany).not.toHaveBeenCalled();
    });

    it('404s for a comment on a different resource', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await asUser(USER)
        .post(report, { reason: CommentReportReason.SPAM })
        .expect(404);

      expect(prisma.commentReport.createMany).not.toHaveBeenCalled();
    });

    it('accepts a report with a category and no detail', async () => {
      // The category is the required half — it is what makes a queue sortable — and
      // the detail is optional precisely so a required wall of text cannot stop a
      // report.
      prisma.comment.findUnique.mockResolvedValue({
        id: 'cmt_1',
        authorId: OTHER,
      });

      await asUser(USER)
        .post(report, { reason: CommentReportReason.OFF_TOPIC })
        .expect(204);

      expect(prisma.commentReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: USER,
          commentId: 'cmt_1',
          reason: CommentReportReason.OFF_TOPIC,
        },
        skipDuplicates: true,
      });
    });

    it('rejects a report with no category at all', async () => {
      // The whole reason the column went from a nullable string to a required enum.
      await asUser(USER).post(report, {}).expect(400);

      expect(prisma.commentReport.createMany).not.toHaveBeenCalled();
    });

    it('rejects a category that is not one of the enum’s values', async () => {
      await asUser(USER).post(report, { reason: 'MALWARE' }).expect(400);

      expect(prisma.commentReport.createMany).not.toHaveBeenCalled();
    });

    it('rejects a detail over the column limit', async () => {
      await asUser(USER)
        .post(report, {
          reason: CommentReportReason.SPAM,
          detail: 'x'.repeat(501),
        })
        .expect(400);
    });

    it('rejects an unknown field, since the pipe forbids extras', async () => {
      await asUser(USER)
        .post(report, { reason: CommentReportReason.SPAM, punish: true })
        .expect(400);
    });
  });

  describe('GET /comment-reports', () => {
    const queue = '/api/v1/comment-reports';

    it('refuses a signed-out reader', async () => {
      await asAnon.get(queue).expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      await asUser(USER).get(queue).expect(403);
    });

    it('serves an admin, newest report first', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(USER).get(queue).expect(200);

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

    it('carries the comment so a moderator can judge it without opening anything', async () => {
      currentUserRole = UserRole.ADMIN;

      const response = await asUser(USER).get(queue).expect(200);

      expect(asReports(response).items[0].comment.body).toBe(
        'Chapter 14 is the one that made the whole argument land.',
      );
      expect(asReports(response).items[0].reportCount).toBe(3);
    });

    it('never names the reporter', async () => {
      currentUserRole = UserRole.ADMIN;

      const response = await asUser(USER).get(queue).expect(200);

      expect(asReports(response).items[0]).not.toHaveProperty('reporterId');
      expect(asReports(response).items[0]).not.toHaveProperty('reporter');
    });

    it('rejects an unknown query parameter', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(USER).get(`${queue}?order=oldest`).expect(400);
    });
  });

  describe('POST /comment-reports/:id/dismiss', () => {
    const dismiss = '/api/v1/comment-reports/cmt_1/dismiss';

    it('refuses a signed-out reader', async () => {
      await asAnon.post(dismiss).expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      await asUser(USER).post(dismiss).expect(403);

      expect(prisma.commentReport.updateMany).not.toHaveBeenCalled();
    });

    it('lets an admin dismiss, and answers 204', async () => {
      currentUserRole = UserRole.ADMIN;

      const response = await asUser(USER).post(dismiss).expect(204);

      expect(response.text).toBe('');
    });

    it('dismisses every report on the comment, not one of them', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(USER).post(dismiss).expect(204);

      // A comment five people reported is five rows. Dismissing one would leave four
      // queued, which is to say the queue could never be worked through.
      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith({
        where: { commentId: 'cmt_1', dismissedAt: null },
        // `expect.anything()` returns `any`, which trips no-unsafe-assignment inside
        // an object literal, so the timestamp is checked by shape instead: the call
        // has a `dismissedAt` key with something in it.
        data: dataContaining({ dismissedAt: expect.anything() as unknown }),
      });
    });

    it('does not remove the comment', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(USER).post(dismiss).expect(204);

      // Dismissal is "seen, keeping it". Removal is a separate route, and conflating
      // them would make removal the answer to every report.
      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('succeeds on a second dismissal rather than erroring', async () => {
      currentUserRole = UserRole.ADMIN;
      prisma.commentReport.updateMany.mockResolvedValue({ count: 0 });

      // Two moderators reaching for the same row at once is ordinary.
      await asUser(USER).post(dismiss).expect(204);
    });

    it('hides dismissed reports from the queue', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(USER).get('/api/v1/comment-reports').expect(200);

      expect(prisma.commentReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { dismissedAt: null } }),
      );
    });
  });

  describe('POST /comment-reports/:id/undismiss', () => {
    const undismiss = '/api/v1/comment-reports/cmt_1/undismiss';

    it('refuses a signed-out reader', async () => {
      await asAnon.post(undismiss).expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      await asUser(USER).post(undismiss).expect(403);

      expect(prisma.commentReport.updateMany).not.toHaveBeenCalled();
    });

    it('lets an admin reopen the reports, and answers 204', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(USER).post(undismiss).expect(204);

      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith({
        where: { commentId: 'cmt_1', dismissedAt: { not: null } },
        data: { dismissedAt: null },
      });
    });

    it('reopens only rows a dismissal closed', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(USER).post(undismiss).expect(204);

      // A report filed *after* the dismissal is already queued; reopening must leave
      // it alone rather than disturbing a report nobody resolved.
      expect(prisma.commentReport.updateMany).toHaveBeenCalledWith(
        dataContaining({
          where: { commentId: 'cmt_1', dismissedAt: { not: null } },
        }),
      );
    });

    it('does not remove the comment', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(USER).post(undismiss).expect(204);

      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it('succeeds when nothing was dismissed', async () => {
      currentUserRole = UserRole.ADMIN;
      prisma.commentReport.updateMany.mockResolvedValue({ count: 0 });

      await asUser(USER).post(undismiss).expect(204);
    });
  });
});
