import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { getAuth } from '@clerk/express';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { validationPipeOptions } from './../src/validation';
import { UserRole } from './../src/generated/prisma/enums';

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
    author: Record<string, unknown> | null;
    isMine: boolean;
  }>;
  nextCursor: string | null;
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
});
