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
      create: jest.Mock;
      delete: jest.Mock;
    };
  };
  let currentUserRole: UserRole;

  const validBody = {
    title: 'Sapiens',
    url: 'https://example.com/sapiens',
    type: ResourceType.BOOK,
    accessType: AccessType.PAID,
    why: 'The clearest explanation of human institutions I have read.',
  };

  const asUser = (userId: string) => ({
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set('x-test-user-id', userId),
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
          create: jest
            .fn()
            .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
              Promise.resolve({ id: 'res_1', ...data, contributor: null }),
            ),
          delete: jest.fn().mockResolvedValue({ id: 'res_1' }),
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
        .expect([]);
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
      });

      const response = await request(app.getHttpServer())
        .get('/api/v1/resources/res_1')
        .expect(200);

      expect((response.body as { id: string }).id).toBe('res_1');
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

    it('DELETE is forbidden for a non-admin', async () => {
      await asUser('clerk_123').delete('/api/v1/resources/res_1').expect(403);

      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });

    it('DELETE succeeds for an admin', async () => {
      currentUserRole = UserRole.ADMIN;
      prisma.resource.findUnique.mockResolvedValue({ id: 'res_1' });

      await asUser('clerk_admin').delete('/api/v1/resources/res_1').expect(200);

      expect(prisma.resource.delete).toHaveBeenCalledWith({
        where: { id: 'res_1' },
      });
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

  afterEach(async () => {
    await app.close();
  });
});
