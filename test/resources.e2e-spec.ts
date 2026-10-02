import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { getAuth } from '@clerk/express';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { validationPipeOptions } from './../src/validation';
import {
  AccessType,
  ResourceType,
  UserRole,
} from './../src/generated/prisma/enums';

// Clerk's `getAuth` requires a request whose `auth` property is branded by
// `clerkMiddleware()`, which only `main.ts` registers. Mocking `getAuth` is the
// same approach `src/clerk-auth/clerk-auth.guard.spec.ts` already uses, and
// keeps these tests free of Clerk keys and network access. `x-test-user-id`
// stands in for the authenticated Clerk session.
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
  clerkClient: { users: { getUser: jest.fn() } },
}));

describe('Resources (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: {
    tag: { createMany: jest.Mock };
    resource: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    resourceReport: { createMany: jest.Mock; findMany: jest.Mock };
  };
  let currentUserRole: UserRole;

  const validBody = {
    title: 'Sapiens',
    url: 'https://example.com/sapiens',
    type: ResourceType.BOOK,
    accessType: AccessType.PAID,
    why: 'The clearest explanation of human institutions I have read.',
  };

  /** A page of the resource report queue. */
  interface ReportsBody {
    items: Array<{
      id: string;
      reportCount: number;
      resource: {
        title: string;
        why: string;
        contributor: unknown;
        contributorId: string | null;
        isAnonymous: boolean;
      };
    }>;
  }

  const asUser = (userId: string) => ({
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set('x-test-user-id', userId),
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('x-test-user-id', userId),
    patch: (url: string) =>
      request(app.getHttpServer()).patch(url).set('x-test-user-id', userId),
    delete: (url: string) =>
      request(app.getHttpServer()).delete(url).set('x-test-user-id', userId),
  });

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
        tag: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
        resource: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
          // No match by default, so the duplicate guard stays out of the way of
          // every other test here.
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest
            .fn()
            .mockResolvedValue({ id: 'res_1', contributor: null }),
          create: jest
            .fn()
            .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
              Promise.resolve({ id: 'res_1', ...data, contributor: null }),
            ),
          delete: jest.fn().mockResolvedValue({ id: 'res_1' }),
        },
        resourceReport: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([
            {
              reporterId: 'clerk_456',
              resourceId: 'res_1',
              reason: 'This link just installed something.',
              createdAt: new Date('2026-03-01T00:00:00.000Z'),
              resource: {
                id: 'res_1',
                ...validBody,
                contributor: null,
                isAnonymous: false,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                updatedAt: new Date('2026-01-01T00:00:00.000Z'),
                tags: [],
                _count: { savedResources: 0, comments: 0, reports: 4 },
              },
            },
          ]),
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
    // The global pipe is registered in main.ts, not AppModule, so the e2e app
    // has to opt in to exercise the same validation rules.
    app.useGlobalPipes(new ValidationPipe(validationPipeOptions));
    await app.init();
  });

  describe('public reads', () => {
    it('GET /api/v1/resources', () => {
      return request(app.getHttpServer())
        .get('/api/v1/resources')
        .expect(200)
        .expect({ items: [], nextCursor: null });
    });

    it('GET /api/v1/resources/:id returns 404 when missing', () => {
      return request(app.getHttpServer())
        .get('/api/v1/resources/res_missing')
        .expect(404);
    });

    it('GET /api/v1/resources/:id returns the resource', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        ...validBody,
        contributor: null,
        isAnonymous: false,
        _count: { savedResources: 0 },
      });

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources/res_1')
        .expect(200);

      expect((response.body as { id: string }).id).toBe('res_1');
    });
  });

  describe('contributor filter', () => {
    it('folds the username in the query string, so casing does not matter', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/resources?contributor=AdaL')
        .expect(200);

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            contributor: { usernameLower: 'adal' },
            isAnonymous: false,
          },
        }),
      );
    });

    it('combines with a tag filter', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/resources?tag=evolution&contributor=adal')
        .expect(200);

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tags: { some: { slug: 'evolution' } },
            contributor: { usernameLower: 'adal' },
            isAnonymous: false,
          },
        }),
      );
    });

    // The profile listing and `resourcesCount` have to agree, and both have to
    // leave withheld posts off the profile.
    it('excludes anonymous contributions from a profile listing', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/resources?contributor=adal')
        .expect(200);

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ where: Record<string, unknown> }],
      ];

      expect(arg.where).toMatchObject({ isAnonymous: false });
    });

    // An unclaimed handle has an empty page rather than a 400, matching how an
    // unknown cursor behaves: the URL is reachable before anything is there.
    it('rejects a username outside the character set rather than querying', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/resources?contributor=ada-lovelace')
        .expect(400);
    });

    it('sends no where clause at all when unfiltered', async () => {
      await request(app.getHttpServer()).get('/api/v1/resources').expect(200);

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ where?: unknown }],
      ];

      expect(arg.where).toBeUndefined();
    });
  });

  describe('profilePath over HTTP', () => {
    const withContributor = (contributor: unknown) => ({
      id: 'res_1',
      ...validBody,
      isAnonymous: false,
      contributorId: 'user_1',
      contributor,
      // Every read row goes through `toResourceResponse`, which flattens the
      // selected count into `savedCount`.
      _count: { savedResources: 0 },
    });

    it('points a public profile at /u/:username', async () => {
      prisma.resource.findUnique.mockResolvedValue(
        withContributor({
          id: 'user_1',
          name: 'Ada Lovelace',
          imageUrl: null,
          usernameLower: 'adal',
          isProfilePrivate: false,
        }),
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources/res_1')
        .expect(200);

      expect(
        (response.body as { contributor: { profilePath: string } }).contributor
          .profilePath,
      ).toBe('/u/adal');
    });

    // The name stays. Privacy withdraws the destination, not the attribution —
    // whether a name appears is `isAnonymous`, a per-resource decision.
    it('omits the link for a private profile without withholding the name', async () => {
      prisma.resource.findUnique.mockResolvedValue(
        withContributor({
          id: 'user_1',
          name: 'Ada Lovelace',
          imageUrl: null,
          usernameLower: 'adal',
          isProfilePrivate: true,
        }),
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources/res_1')
        .expect(200);

      const { contributor } = response.body as {
        contributor: { name: string; profilePath: string | null };
      };

      expect(contributor.profilePath).toBeNull();
      expect(contributor.name).toBe('Ada Lovelace');
    });

    it('leaves no username in the payload for a private profile', async () => {
      prisma.resource.findUnique.mockResolvedValue(
        withContributor({
          id: 'user_1',
          name: 'Ada Lovelace',
          imageUrl: null,
          usernameLower: 'adal',
          isProfilePrivate: true,
        }),
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources/res_1')
        .expect(200);

      // The two fields the path is derived from are not part of the response, so
      // a client cannot reconstruct a link the server declined to make.
      const body = response.body as { contributor: unknown };

      expect(body.contributor).not.toHaveProperty('usernameLower');
      expect(body.contributor).not.toHaveProperty('isProfilePrivate');
    });
  });

  describe('anonymity over HTTP', () => {
    const anonymous = {
      id: 'res_anon',
      ...validBody,
      isAnonymous: true,
      contributorId: 'user_1',
      contributor: { id: 'user_1', name: 'Ada Lovelace', imageUrl: null },
      _count: { savedResources: 0 },
    };

    it('withholds the contributor from a signed-out reader', async () => {
      prisma.resource.findUnique.mockResolvedValue(anonymous);

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources/res_anon')
        .expect(200);

      const body = response.body as {
        contributor: unknown;
        contributorId: string | null;
        isAnonymous: boolean;
      };

      expect(body.contributor).toBeNull();
      expect(body.contributorId).toBeNull();
      // The client needs this to word the card: an anonymous post and a
      // deleted contributor are different states.
      expect(body.isAnonymous).toBe(true);
    });

    it('leaks no identifying field in the body at all', async () => {
      prisma.resource.findUnique.mockResolvedValue(anonymous);

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources/res_anon')
        .expect(200);

      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain('Ada');
      expect(raw).not.toContain('user_1');
    });

    it('shows it to the owner despite anonymity', async () => {
      prisma.resource.findUnique.mockResolvedValue(anonymous);

      const response = await asUser('user_1')
        .get('/api/v1/resources/res_anon')
        .expect(200);

      expect(
        (response.body as { contributorId: string | null }).contributorId,
      ).toBe('user_1');
    });

    it('still withholds it from a signed-in stranger', async () => {
      prisma.resource.findUnique.mockResolvedValue(anonymous);

      const response = await asUser('user_other')
        .get('/api/v1/resources/res_anon')
        .expect(200);

      expect(
        (response.body as { contributorId: string | null }).contributorId,
      ).toBeNull();
    });

    it('GET /api/v1/resources/:id/mine is true for the contributor', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        contributorId: 'user_1',
        _count: { savedResources: 0 },
      });

      const response = await asUser('user_1')
        .get('/api/v1/resources/res_anon/mine')
        .expect(200);

      expect(response.body).toEqual({ isMine: true });
    });

    it('GET /api/v1/resources/:id/mine is false for a stranger', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        contributorId: 'user_1',
        _count: { savedResources: 0 },
      });

      const response = await asUser('user_other')
        .get('/api/v1/resources/res_anon/mine')
        .expect(200);

      expect(response.body).toEqual({ isMine: false });
    });

    it('GET /api/v1/resources/:id/mine needs a session', () => {
      return request(app.getHttpServer())
        .get('/api/v1/resources/res_anon/mine')
        .expect(401);
    });

    it('POST accepts isAnonymous', async () => {
      prisma.resource.create.mockResolvedValue({
        id: 'res_1',
        ...validBody,
        isAnonymous: true,
        contributor: null,
      });

      await asUser('user_1')
        .post('/api/v1/resources')
        .send({ ...validBody, isAnonymous: true })
        .expect(201);

      const [[arg]] = prisma.resource.create.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(arg.data.isAnonymous).toBe(true);
    });

    it('POST rejects a non-boolean isAnonymous', () => {
      return asUser('user_1')
        .post('/api/v1/resources')
        .send({ ...validBody, isAnonymous: 'yes' })
        .expect(400);
    });

    // Regression: `Boolean("false")` is `true`, so implicit conversion turned a
    // client asking not to be anonymous into one who was. On a privacy flag the
    // silent inversion is worse than the error.
    it('POST does not read the string "false" as true', () => {
      return asUser('user_1')
        .post('/api/v1/resources')
        .send({ ...validBody, isAnonymous: 'false' })
        .expect(400);
    });

    it('PATCH refuses to un-anonymise somebody else’s resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(anonymous);

      await asUser('user_other')
        .patch('/api/v1/resources/res_anon')
        .send({ isAnonymous: false })
        .expect(403);

      expect(prisma.resource.update).not.toHaveBeenCalled();
    });

    it('PATCH lets the owner un-anonymise their own resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(anonymous);
      prisma.resource.update.mockResolvedValue({
        id: 'res_anon',
        isAnonymous: false,
      });

      await asUser('user_1')
        .patch('/api/v1/resources/res_anon')
        .send({ isAnonymous: false })
        .expect(200);

      const [[arg]] = prisma.resource.update.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(arg.data.isAnonymous).toBe(false);
    });
  });

  // Auth is opt-in per controller, so a missing @UseGuards would leave these
  // routes publicly reachable. These 401s are the regression guard.
  describe('guarded writes reject anonymous callers', () => {
    it('POST /api/v1/resources', () => {
      return request(app.getHttpServer())
        .post('/api/v1/resources')
        .send(validBody)
        .expect(401);
    });

    it('PATCH /api/v1/resources/:id', () => {
      return request(app.getHttpServer())
        .patch('/api/v1/resources/res_1')
        .send({ title: 'New' })
        .expect(401);
    });

    it('DELETE /api/v1/resources/:id', () => {
      return request(app.getHttpServer())
        .delete('/api/v1/resources/res_1')
        .expect(401);
    });
  });

  describe('authenticated writes', () => {
    it('POST creates a resource attributed to the caller', async () => {
      await asUser('clerk_123')
        .post('/api/v1/resources')
        .send(validBody)
        .expect(201);

      const [[{ data }]] = prisma.resource.create.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(data).toMatchObject({ ...validBody, contributorId: 'clerk_123' });
    });

    it('POST leaves accessType unset when the client omits it, deferring to the schema default', async () => {
      await asUser('clerk_123')
        .post('/api/v1/resources')
        .send({
          title: validBody.title,
          url: validBody.url,
          type: validBody.type,
          why: validBody.why,
        })
        .expect(201);

      const [[{ data }]] = prisma.resource.create.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];

      // The pipe instantiates the DTO, so the optional property is present but
      // empty. Prisma reads `undefined` as "not provided" and applies
      // `@default(UNKNOWN)`.
      expect(data.accessType).toBeUndefined();
    });

    // forbidNonWhitelisted is on globally, and guards run before pipes, so
    // these only reach validation once the caller is authenticated.
    it.each([
      ['a javascript: url', { url: 'javascript:alert(1)' }],
      ['a url with no protocol', { url: 'example.com/sapiens' }],
      ['an unknown type', { type: 'SCROLL' }],
      ['a missing why', { why: undefined }],
      ['an over-long title', { title: 'x'.repeat(201) }],
      ['an undeclared field', { summary: 'nope' }],
      // Security: a client must not be able to claim authorship.
      [
        'a client-supplied contributorId',
        { contributorId: 'clerk_someone_else' },
      ],
    ])('POST rejects %s', async (_label, override) => {
      await asUser('clerk_123')
        .post('/api/v1/resources')
        .send({ ...validBody, ...override })
        .expect(400);

      expect(prisma.resource.create).not.toHaveBeenCalled();
    });

    describe('duplicate links', () => {
      it('POST 409s when the contributor already shared that link', async () => {
        prisma.resource.findFirst.mockResolvedValue({ id: 'res_other' });

        const response = await asUser('clerk_123')
          .post('/api/v1/resources')
          .send(validBody)
          .expect(409);

        expect(prisma.resource.create).not.toHaveBeenCalled();
        expect(JSON.stringify(response.body)).toContain(
          'already shared this link',
        );
      });

      // The whole point of scoping the check to the contributor: two people
      // finding the same thing is the product working, and each `why` is the
      // value. A global check would throw one of those away.
      it('POST allows a different contributor to share the same link', async () => {
        prisma.resource.findFirst.mockImplementation(
          ({ where }: { where: { contributorId: string } }) =>
            Promise.resolve(
              where.contributorId === 'clerk_someone_else'
                ? { id: 'res_other' }
                : null,
            ),
        );

        await asUser('clerk_123')
          .post('/api/v1/resources')
          .send(validBody)
          .expect(201);
      });

      it('PATCH 409s when the new URL is one the contributor already shared', async () => {
        prisma.resource.findUnique.mockResolvedValue({
          id: 'res_1',
          contributorId: 'clerk_123',
          _count: { savedResources: 0 },
        });
        prisma.resource.findFirst.mockResolvedValue({ id: 'res_other' });

        await asUser('clerk_123')
          .patch('/api/v1/resources/res_1')
          .send({ url: 'https://example.com/sapiens' })
          .expect(409);

        expect(prisma.resource.update).not.toHaveBeenCalled();
      });

      it('PATCH without a URL change is not checked at all', async () => {
        prisma.resource.findUnique.mockResolvedValue({
          id: 'res_1',
          contributorId: 'clerk_123',
          _count: { savedResources: 0 },
        });

        await asUser('clerk_123')
          .patch('/api/v1/resources/res_1')
          .send({ title: 'A better title' })
          .expect(200);

        expect(prisma.resource.findFirst).not.toHaveBeenCalled();
      });
    });

    it('DELETE is forbidden for a signed-in stranger', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'someone_else',
        _count: { savedResources: 0 },
      });

      await asUser('clerk_123').delete('/api/v1/resources/res_1').expect(403);

      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });

    // Deleting your own contribution is the only self-service correction the
    // product offers, so it must not require an admin.
    it('DELETE succeeds for the contributor', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'clerk_123',
        _count: { savedResources: 0 },
      });

      await asUser('clerk_123').delete('/api/v1/resources/res_1').expect(200);

      expect(prisma.resource.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'res_1' } }),
      );
    });

    it('DELETE succeeds for an admin', async () => {
      currentUserRole = UserRole.ADMIN;
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'someone_else',
        _count: { savedResources: 0 },
      });

      await asUser('clerk_admin').delete('/api/v1/resources/res_1').expect(200);

      expect(prisma.resource.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'res_1' } }),
      );
    });
  });

  describe('pagination', () => {
    // Minimal by design — these tests are about pagination arithmetic. `_count` is
    // still present because every read row goes through `toResourceResponse`.
    const row = (id: string) => ({
      id,
      createdAt: new Date(),
      _count: { savedResources: 0 },
    });

    it('defaults to 20 rows and fetches 21 to detect a next page', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await request(app.getHttpServer()).get('/api/v1/resources').expect(200);

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ take: number }],
      ];
      expect(arg.take).toBe(21);
    });

    it('returns a nextCursor when more rows exist', async () => {
      prisma.resource.findMany.mockResolvedValue([
        row('a'),
        row('b'),
        row('c'),
      ]);

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources?limit=2')
        .expect(200);

      const body = response.body as {
        items: unknown[];
        nextCursor: string | null;
      };
      expect(body.items).toHaveLength(2);
      expect(body.nextCursor).toEqual(expect.any(String));
    });

    it('returns a null cursor on the final page', async () => {
      prisma.resource.findMany.mockResolvedValue([row('a'), row('b')]);

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources?limit=2')
        .expect(200);

      expect(
        (response.body as { nextCursor: string | null }).nextCursor,
      ).toBeNull();
    });

    it('forwards a cursor to the query', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get('/api/v1/resources?cursor=Y2tzYWZxMmE=')
        .expect(200);

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ cursor: { id: string }; skip: number }],
      ];
      expect(arg.cursor).toEqual({ id: 'cksafq2a' });
      expect(arg.skip).toBe(1);
    });

    it.each([
      ['limit=0', '?limit=0'],
      ['limit=101', '?limit=101'],
      ['limit=abc', '?limit=abc'],
      ['a non-numeric cursor', '?cursor=%21%21%21'],
    ])('rejects %s', async (_label, query) => {
      await request(app.getHttpServer())
        .get(`/api/v1/resources${query}`)
        .expect(400);
    });

    it('accepts the maximum limit', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get('/api/v1/resources?limit=100')
        .expect(200);

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ take: number }],
      ];
      expect(arg.take).toBe(101);
    });
  });

  describe('tag filtering', () => {
    it('GET /api/v1/resources?tag= scopes to that tag slug', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/resources?tag=machine-learning')
        .expect(200);

      const [[{ where }]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ where: unknown }],
      ];
      expect(where).toEqual({ tags: { some: { slug: 'machine-learning' } } });
    });

    it('GET /api/v1/resources with no tag does not filter', async () => {
      await request(app.getHttpServer()).get('/api/v1/resources').expect(200);

      const [[{ where }]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ where: unknown }],
      ];
      expect(where).toBeUndefined();
    });

    it('GET /api/v1/resources?tag= rejects a value that is not a slug', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/resources?tag=Machine%20Learning')
        .expect(400);
    });

    it('GET /api/v1/resources?tag= rejects an unknown query parameter', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/resources?type=BOOK')
        .expect(400);
    });
  });

  describe('tags on write', () => {
    it('POST creates tags implicitly and connects them', async () => {
      await asUser('clerk_123')
        .post('/api/v1/resources')
        .send({ ...validBody, tags: ['Machine Learning', 'C++'] })
        .expect(201);

      expect(prisma.tag.createMany).toHaveBeenCalledWith({
        data: [
          { name: 'Machine Learning', slug: 'machine-learning' },
          { name: 'C++', slug: 'c++' },
        ],
        skipDuplicates: true,
      });

      const [[{ data }]] = prisma.resource.create.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(data.tags).toEqual({
        connect: [{ slug: 'machine-learning' }, { slug: 'c++' }],
      });
    });

    it('POST collapses two spellings of the same tag into one', async () => {
      await asUser('clerk_123')
        .post('/api/v1/resources')
        .send({ ...validBody, tags: ['Machine Learning', 'machine-learning'] })
        .expect(201);

      expect(prisma.tag.createMany).toHaveBeenCalledWith({
        data: [{ name: 'Machine Learning', slug: 'machine-learning' }],
        skipDuplicates: true,
      });
    });

    it('POST succeeds with no tags at all', async () => {
      await asUser('clerk_123')
        .post('/api/v1/resources')
        .send(validBody)
        .expect(201);

      expect(prisma.tag.createMany).not.toHaveBeenCalled();
    });

    it('POST rejects more than five tags', async () => {
      await asUser('clerk_123')
        .post('/api/v1/resources')
        .send({
          ...validBody,
          tags: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'],
        })
        .expect(400);

      expect(prisma.resource.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a tag with no usable characters', '!!!'],
      ['a one-character tag', 'a'],
      ['an over-long tag', 'a'.repeat(41)],
    ])('POST rejects %s', async (_label, tag) => {
      await asUser('clerk_123')
        .post('/api/v1/resources')
        .send({ ...validBody, tags: [tag] })
        .expect(400);

      expect(prisma.resource.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /resources/:id/report', () => {
    const report = (id = 'res_1') => `/api/v1/resources/${id}/report`;

    beforeEach(() => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'clerk_123',
      });
    });

    it('requires a session', async () => {
      await request(app.getHttpServer()).post(report()).expect(401);
    });

    it('files the report and answers 204 with no body', async () => {
      const response = await asUser('clerk_456')
        .post(report())
        .send({ reason: 'This link just installed something.' })
        .expect(204);

      expect(response.text).toBe('');
      expect(prisma.resourceReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: 'clerk_456',
          resourceId: 'res_1',
          reason: 'This link just installed something.',
        },
        skipDuplicates: true,
      });
    });

    it('does not change the resource, so a report is invisible to readers', async () => {
      await asUser('clerk_456').post(report()).send({}).expect(204);

      expect(prisma.resource.update).not.toHaveBeenCalled();
      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });

    it('refuses a report on your own contribution', async () => {
      await asUser('clerk_123').post(report()).send({}).expect(400);

      expect(prisma.resourceReport.createMany).not.toHaveBeenCalled();
    });

    it('404s for a resource that is not there', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await asUser('clerk_456').post(report()).send({}).expect(404);
    });

    it('accepts a report with no reason at all', async () => {
      await asUser('clerk_456').post(report()).send({}).expect(204);

      expect(prisma.resourceReport.createMany).toHaveBeenCalledWith({
        data: { reporterId: 'clerk_456', resourceId: 'res_1' },
        skipDuplicates: true,
      });
    });

    it('rejects a reason over the column limit', async () => {
      await asUser('clerk_456')
        .post(report())
        .send({ reason: 'x'.repeat(501) })
        .expect(400);
    });

    it('rejects an unknown field, since the pipe forbids extras', async () => {
      await asUser('clerk_456')
        .post(report())
        .send({ reason: 'Spam.', remove: true })
        .expect(400);
    });
  });

  describe('GET /resource-reports', () => {
    const queue = '/api/v1/resource-reports';

    it('refuses a signed-out reader', async () => {
      await request(app.getHttpServer()).get(queue).expect(401);
    });

    it('refuses a signed-in non-admin', async () => {
      await asUser('clerk_123').get(queue).expect(403);
    });

    it('serves an admin, newest report first', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser('clerk_123').get(queue).expect(200);

      expect(prisma.resourceReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { createdAt: 'desc' },
            { reporterId: 'desc' },
            { resourceId: 'desc' },
          ],
        }),
      );
    });

    it('never names the reporter', async () => {
      currentUserRole = UserRole.ADMIN;

      const response = await asUser('clerk_123').get(queue).expect(200);

      const row = (response.body as ReportsBody).items[0];
      expect(row).not.toHaveProperty('reporterId');
      expect(row).not.toHaveProperty('reporter');
      expect(row.id).toBe('res_1:clerk_456');
    });

    it('carries the resource so a moderator can judge it without opening anything', async () => {
      currentUserRole = UserRole.ADMIN;

      const response = await asUser('clerk_123').get(queue).expect(200);

      const row = (response.body as ReportsBody).items[0];
      expect(row.resource.title).toBe('Sapiens');
      expect(row.resource.why).toContain('clearest explanation');
      expect(row.reportCount).toBe(4);
    });

    it('still redacts an anonymously shared contribution', async () => {
      currentUserRole = UserRole.ADMIN;
      prisma.resourceReport.findMany.mockResolvedValue([
        {
          reporterId: 'clerk_456',
          resourceId: 'res_1',
          reason: null,
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          resource: {
            id: 'res_1',
            ...validBody,
            contributor: { id: 'clerk_789', name: 'Ada' },
            contributorId: 'clerk_789',
            isAnonymous: true,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            tags: [],
            _count: { savedResources: 0, comments: 0, reports: 1 },
          },
        },
      ]);

      const response = await asUser('clerk_123').get(queue).expect(200);

      const row = (response.body as ReportsBody).items[0];
      expect(row.resource.contributor).toBeNull();
      expect(row.resource.isAnonymous).toBe(true);
    });

    it('rejects an unknown query parameter', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser('clerk_123').get(`${queue}?order=oldest`).expect(400);
    });
  });

  afterEach(async () => {
    await app.close();
  });
});
