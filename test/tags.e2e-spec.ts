import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { getAuth } from '@clerk/express';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { validationPipeOptions } from './../src/validation';
import { TAG_SLUG_MAX_LENGTH } from './../src/tags/slugify.util';

// See resources.e2e-spec.ts for why getAuth is mocked rather than satisfied by
// a fake `req.auth`.
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
  clerkClient: { users: { getUser: jest.fn() } },
}));

describe('Tags (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: { tag: { findMany: jest.Mock } };

  const tagRow = (slug: string, resourceCount: number) => ({
    id: `id_${slug}`,
    name: slug,
    slug,
    _count: { resources: resourceCount },
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        user: {
          findUnique: jest
            .fn()
            .mockImplementation(({ where }: { where: { id: string } }) =>
              Promise.resolve({ id: where.id, role: 'USER' }),
            ),
        },
        tag: { findMany: jest.fn().mockResolvedValue([]) },
        resource: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
        },
      })
      .compile();

    prisma = moduleFixture.get(PrismaService);

    (getAuth as jest.Mock).mockImplementation(() => ({ userId: null }));

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe(validationPipeOptions));
    await app.init();
  });

  it('GET /api/v1/tags is public and returns the most-used tags', async () => {
    prisma.tag.findMany.mockResolvedValue([
      tagRow('rare', 1),
      tagRow('popular', 12),
    ]);

    const response = await request(app.getHttpServer())
      .get('/api/v1/tags')
      .expect(200);

    const [[{ where }]] = prisma.tag.findMany.mock.calls as unknown as [
      [{ where: unknown }],
    ];
    expect(where).toBeUndefined();

    const slugs = (response.body as { slug: string }[]).map((t) => t.slug);
    expect(slugs).toEqual(['popular', 'rare']);
  });

  it('exposes a flat resourceCount rather than the raw _count', async () => {
    prisma.tag.findMany.mockResolvedValue([tagRow('evolution', 4)]);

    const response = await request(app.getHttpServer())
      .get('/api/v1/tags')
      .expect(200);

    expect((response.body as Record<string, unknown>[])[0]).toEqual({
      id: 'id_evolution',
      name: 'evolution',
      slug: 'evolution',
      resourceCount: 4,
    });
  });

  it('GET /api/v1/tags?query= searches names case-insensitively and slugs by their stored form', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/tags?query=machine')
      .expect(200);

    const [[{ where }]] = prisma.tag.findMany.mock.calls as unknown as [
      [{ where: unknown }],
    ];
    expect(where).toEqual({
      OR: [
        { name: { contains: 'machine', mode: 'insensitive' } },
        { slug: { contains: 'machine' } },
      ],
    });
  });

  it('GET /api/v1/tags?query= lowercases the query for the slug match', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/tags?query=C%2B%2B')
      .expect(200);

    const [[{ where }]] = prisma.tag.findMany.mock.calls as unknown as [
      [{ where: { OR: unknown[] } }],
    ];
    expect(where.OR).toContainEqual({ slug: { contains: 'c++' } });
  });

  it(`GET /api/v1/tags?query= rejects a query longer than ${TAG_SLUG_MAX_LENGTH}`, async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/tags?query=${'a'.repeat(TAG_SLUG_MAX_LENGTH + 1)}`)
      .expect(400);
  });

  it('GET /api/v1/tags rejects an unknown query parameter', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/tags?limit=100')
      .expect(400);
  });

  afterEach(async () => {
    await app.close();
  });
});
