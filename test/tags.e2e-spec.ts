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
  let prisma: {
    tag: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let currentUserRole: 'USER' | 'ADMIN';

  const tagRow = (slug: string, resourceCount: number) => ({
    id: `id_${slug}`,
    name: slug,
    slug,
    _count: { resources: resourceCount },
  });

  const asUser = (userId: string) => ({
    patch: (url: string) =>
      request(app.getHttpServer()).patch(url).set('x-test-user-id', userId),
    delete: (url: string) =>
      request(app.getHttpServer()).delete(url).set('x-test-user-id', userId),
  });

  beforeEach(async () => {
    currentUserRole = 'USER';

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
        tag: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest
            .fn()
            .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
              Promise.resolve({ ...tagRow('renamed', 0), ...data }),
            ),
          delete: jest.fn().mockResolvedValue(tagRow('orphan', 0)),
        },
        resource: {
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
      .get('/api/v1/tags?perPage=100')
      .expect(400);
  });

  it('GET /api/v1/tags returns the twenty-tag cut when no limit is given', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      tagRow(`tag-${i.toString().padStart(2, '0')}`, i),
    );
    prisma.tag.findMany.mockResolvedValue(many);

    const response = await request(app.getHttpServer())
      .get('/api/v1/tags')
      .expect(200);

    // The nav depends on this being a cut, not the whole vocabulary.
    expect((response.body as unknown[]).length).toBe(20);
  });

  it('GET /api/v1/tags?limit= returns the whole vocabulary when asked', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      tagRow(`tag-${i.toString().padStart(2, '0')}`, i),
    );
    prisma.tag.findMany.mockResolvedValue(many);

    const response = await request(app.getHttpServer())
      .get('/api/v1/tags?limit=500')
      .expect(200);

    expect((response.body as unknown[]).length).toBe(40);
  });

  it('GET /api/v1/tags?limit= rejects a limit above the ceiling', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/tags?limit=1001')
      .expect(400);
  });

  describe('GET /api/v1/tags/:slug', () => {
    it('is public and returns the tag with a flat resourceCount', async () => {
      prisma.tag.findUnique.mockResolvedValue(tagRow('evolution', 6));

      const response = await request(app.getHttpServer())
        .get('/api/v1/tags/evolution')
        .expect(200);

      expect(response.body).toEqual({
        id: 'id_evolution',
        name: 'evolution',
        slug: 'evolution',
        resourceCount: 6,
      });
    });

    it('404s for a tag that does not exist', async () => {
      prisma.tag.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/api/v1/tags/nonesuch')
        .expect(404);
    });

    // No substring fallback: `/tags/mach` must not answer for
    // `/tags/machine-learning`, because the tag page is self-canonical and two
    // tags contending for one URL is a canonical pointing at the wrong page.
    it('404s for a prefix of a real slug rather than matching it', async () => {
      prisma.tag.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer()).get('/api/v1/tags/evol').expect(404);

      expect(prisma.tag.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: 'evol' } }),
      );
    });

    it('404s for a slug too short to be a tag, without querying', async () => {
      await request(app.getHttpServer()).get('/api/v1/tags/a').expect(404);

      expect(prisma.tag.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('admin writes', () => {
    it('PATCH /api/v1/tags/:id requires a session', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/tags/tag_1')
        .send({ name: 'Machine Learning' })
        .expect(401);
    });

    it('DELETE /api/v1/tags/:id requires a session', async () => {
      await request(app.getHttpServer())
        .delete('/api/v1/tags/tag_1')
        .expect(401);
    });

    it('PATCH is forbidden for a signed-in non-admin', async () => {
      await asUser('clerk_123')
        .patch('/api/v1/tags/tag_1')
        .send({ name: 'Machine Learning' })
        .expect(403);

      expect(prisma.tag.update).not.toHaveBeenCalled();
    });

    it('DELETE is forbidden for a signed-in non-admin', async () => {
      await asUser('clerk_123').delete('/api/v1/tags/tag_1').expect(403);

      expect(prisma.tag.delete).not.toHaveBeenCalled();
    });

    // The slug is the tag's identity and it lives in feed URLs other people
    // have linked. `forbidNonWhitelisted` is on globally, so a client trying to
    // set it gets a 400 rather than silently rewriting every existing link.
    it('PATCH refuses a slug, so feed URLs cannot be broken', async () => {
      currentUserRole = 'ADMIN';

      await asUser('clerk_admin')
        .patch('/api/v1/tags/tag_1')
        .send({ name: 'Machine Learning', slug: 'ml' })
        .expect(400);

      expect(prisma.tag.update).not.toHaveBeenCalled();
    });

    it('PATCH renames the display form for an admin', async () => {
      currentUserRole = 'ADMIN';

      await asUser('clerk_admin')
        .patch('/api/v1/tags/tag_1')
        .send({ name: 'Machine Learning' })
        .expect(200);

      const [[arg]] = prisma.tag.update.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(arg.data).toEqual({ name: 'Machine Learning' });
    });

    it('DELETE 409s while the tag is still attached', async () => {
      currentUserRole = 'ADMIN';
      prisma.tag.findUnique.mockResolvedValue(tagRow('ai', 7));

      const response = await asUser('clerk_admin')
        .delete('/api/v1/tags/tag_1')
        .expect(409);

      expect(prisma.tag.delete).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).toContain('still on 7');
    });

    it('DELETE removes an unreferenced tag', async () => {
      currentUserRole = 'ADMIN';
      prisma.tag.findUnique.mockResolvedValue(tagRow('orphan', 0));

      await asUser('clerk_admin').delete('/api/v1/tags/tag_1').expect(200);

      expect(prisma.tag.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tag_1' } }),
      );
    });
  });

  afterEach(async () => {
    await app.close();
  });
});
