import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { getAuth } from '@clerk/express';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { validationPipeOptions } from './../src/validation';
import { UserRole } from './../src/generated/prisma/enums';

// Same approach as `resources.e2e-spec.ts`: `getAuth` needs a request branded by
// `clerkMiddleware()`, which only `main.ts` registers. `x-test-user-id` stands in
// for the authenticated Clerk session.
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
  clerkClient: { users: { getUser: jest.fn() } },
}));

const USER = 'user_1';
const OTHER = 'user_2';
const RESOURCE = 'res_1';

function resourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOURCE,
    title: 'Sapiens',
    url: 'https://example.com/sapiens',
    type: 'BOOK',
    accessType: 'PAID',
    why: 'The clearest account I have read.',
    isAnonymous: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    contributorId: 'user_contributor',
    contributor: null,
    tags: [],
    _count: { savedResources: 0 },
    ...overrides,
  };
}

describe('Saved (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: {
    resource: { findUnique: jest.Mock };
    savedResource: {
      createMany: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
    user: { findUnique: jest.Mock };
  };
  let currentUserRole: UserRole;

  const asUser = (userId: string) => ({
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set('x-test-user-id', userId),
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('x-test-user-id', userId),
    delete: (url: string) =>
      request(app.getHttpServer()).delete(url).set('x-test-user-id', userId),
  });

  const asAnon = {
    get: (url: string) => request(app.getHttpServer()).get(url),
    post: (url: string) => request(app.getHttpServer()).post(url),
    delete: (url: string) => request(app.getHttpServer()).delete(url),
  };

  beforeEach(async () => {
    currentUserRole = UserRole.USER;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        user: {
          findUnique: jest
            .fn()
            .mockImplementation(({ where }: { where: { id: string } }) =>
              Promise.resolve({ id: where.id, role: currentUserRole }),
            ),
        },
        resource: {
          findUnique: jest.fn().mockResolvedValue(resourceRow()),
        },
        savedResource: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
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
    it('requires a session to list', async () => {
      await asAnon.get('/api/v1/saved').expect(401);
    });

    it('requires a session to check one', async () => {
      await asAnon.get(`/api/v1/saved/${RESOURCE}`).expect(401);
    });

    it('requires a session to save', async () => {
      await asAnon
        .post('/api/v1/saved')
        .send({ resourceId: RESOURCE })
        .expect(401);
    });

    it('requires a session to unsave', async () => {
      await asAnon.delete(`/api/v1/saved/${RESOURCE}`).expect(401);
    });

    it('does not expose an admin path to somebody else’s list', async () => {
      currentUserRole = UserRole.ADMIN;

      // Even an admin gets their own empty list rather than another's.
      await asUser(USER).get('/api/v1/saved').expect(200);

      expect(prisma.savedResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER } }),
      );
    });
  });

  describe('GET /saved', () => {
    it('lists the caller’s own saved resources', async () => {
      prisma.savedResource.findMany.mockResolvedValue([
        { resourceId: RESOURCE, resource: resourceRow() },
      ]);

      const response = await asUser(USER).get('/api/v1/saved').expect(200);

      expect((response.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('scopes by the caller, never by a body or query param', async () => {
      await asUser(USER).get('/api/v1/saved?userId=user_2').expect(400);

      // `forbidNonWhitelisted` rejects it, so one account's list can never be
      // addressed through the query string.
      expect(prisma.savedResource.findMany).not.toHaveBeenCalled();
    });

    it('rejects an over-long limit', async () => {
      await asUser(USER).get('/api/v1/saved?limit=1000').expect(400);
    });

    it('rejects a malformed cursor', async () => {
      await asUser(USER)
        .get(`/api/v1/saved?cursor=${encodeURIComponent('!!!')}`)
        .expect(400);
    });
  });

  describe('GET /saved/:resourceId', () => {
    it('is false when it is not saved', async () => {
      const response = await asUser(USER)
        .get(`/api/v1/saved/${RESOURCE}`)
        .expect(200);

      expect(response.body).toEqual({ isSaved: false });
    });

    it('is true when it is', async () => {
      prisma.savedResource.findUnique.mockResolvedValue({
        resourceId: RESOURCE,
      });

      const response = await asUser(USER)
        .get(`/api/v1/saved/${RESOURCE}`)
        .expect(200);

      expect(response.body).toEqual({ isSaved: true });
    });
  });

  describe('POST /saved', () => {
    it('saves a resource', async () => {
      await asUser(USER)
        .post('/api/v1/saved')
        .send({ resourceId: RESOURCE })
        .expect(200);

      expect(prisma.savedResource.createMany).toHaveBeenCalledWith({
        data: { userId: USER, resourceId: RESOURCE },
        skipDuplicates: true,
      });
    });

    it('is idempotent, so a double click is not a 409', async () => {
      await asUser(USER)
        .post('/api/v1/saved')
        .send({ resourceId: RESOURCE })
        .expect(200);
    });

    it('returns the resource so the count can be rendered', async () => {
      prisma.resource.findUnique.mockResolvedValue(
        resourceRow({ _count: { savedResources: 7 } }),
      );

      const response = await asUser(USER)
        .post('/api/v1/saved')
        .send({ resourceId: RESOURCE })
        .expect(200);

      expect((response.body as { savedCount: number }).savedCount).toBe(7);
    });

    it('404s a resource that does not exist', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await asUser(USER)
        .post('/api/v1/saved')
        .send({ resourceId: 'res_nope' })
        .expect(404);

      expect(prisma.savedResource.createMany).not.toHaveBeenCalled();
    });

    it('rejects a body with no resource id', async () => {
      await asUser(USER).post('/api/v1/saved').send({}).expect(400);
    });

    it('rejects an unknown property', async () => {
      await asUser(USER)
        .post('/api/v1/saved')
        .send({ resourceId: RESOURCE, userId: OTHER })
        .expect(400);
    });
  });

  describe('DELETE /saved/:resourceId', () => {
    it('removes it', async () => {
      await asUser(USER).delete(`/api/v1/saved/${RESOURCE}`).expect(200);

      expect(prisma.savedResource.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER, resourceId: RESOURCE },
      });
    });

    it('succeeds when it was not saved', async () => {
      prisma.savedResource.deleteMany.mockResolvedValue({ count: 0 });

      await asUser(USER).delete(`/api/v1/saved/${RESOURCE}`).expect(200);
    });

    it('never touches another account’s row', async () => {
      await asUser(USER).delete(`/api/v1/saved/${RESOURCE}`).expect(200);

      expect(prisma.savedResource.deleteMany).toHaveBeenCalledWith({
        // Both halves of the key, so the row removed is provably the caller's
        // and not merely *a* row for this resource.
        where: { userId: USER, resourceId: RESOURCE },
      });
    });
  });

  describe('independence from collections', () => {
    it('does not remove a collection membership when unsaving', async () => {
      await asUser(USER).delete(`/api/v1/saved/${RESOURCE}`).expect(200);

      // The whole point: a bookmark and a curation are separate acts, so
      // unsaving must not quietly undo somebody having filed it somewhere. One
      // delete, scoped to the saved row, and nothing else.
      expect(prisma.savedResource.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.savedResource.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER, resourceId: RESOURCE },
      });
    });
  });
});
