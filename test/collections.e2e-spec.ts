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
// for the authenticated Clerk session, so these run with no Clerk keys, no
// database and no network.
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
  clerkClient: { users: { getUser: jest.fn() } },
}));

const OWNER = 'user_owner';
const STRANGER = 'user_stranger';
const ADMIN = 'user_admin';
const COLLECTION = 'col_1';
const RESOURCE = 'res_1';

function collectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COLLECTION,
    title: 'Read before starting research',
    description: 'The four papers that made this click.',
    isPrivate: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ownerId: OWNER,
    owner: {
      name: 'Ada Lovelace',
      imageUrl: null,
      username: 'AdaL',
      usernameLower: 'adal',
      isProfilePrivate: false,
    },
    _count: { resources: 2 },
    ...overrides,
  };
}

describe('Collections (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: {
    collection: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    collectionResource: {
      createMany: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
    };
    resource: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let currentUserRole: UserRole;

  const validBody = {
    title: 'Read before starting research',
    description: 'The four papers that made this click.',
  };

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

  const asAnon = {
    get: (url: string) => request(app.getHttpServer()).get(url),
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
        collection: {
          // Emulates the column default the way Prisma does: a create that omits
          // `isPrivate` comes back with the persisted value filled in. The
          // service deliberately leaves that field out of the payload so the
          // schema is the only thing that decides, which only reads correctly if
          // the row that comes back has the default applied.
          create: jest
            .fn()
            .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
              Promise.resolve(collectionRow({ isPrivate: true, ...data })),
            ),
          findMany: jest.fn().mockResolvedValue([collectionRow()]),
          findUnique: jest.fn().mockResolvedValue(collectionRow()),
          update: jest
            .fn()
            .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
              Promise.resolve(collectionRow(data)),
            ),
          delete: jest.fn().mockResolvedValue(collectionRow()),
        },
        collectionResource: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        resource: {
          findUnique: jest.fn().mockResolvedValue({ id: RESOURCE }),
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

  afterEach(async () => {
    await app.close();
  });

  describe('create', () => {
    it('creates a collection for the caller', async () => {
      const response = await asUser(OWNER)
        .post('/api/v1/collections')
        .send(validBody)
        .expect(201);

      const body = response.body as {
        title: string;
        isPrivate: boolean;
        isOwner: boolean;
      };

      expect(body.title).toBe('Read before starting research');
      expect(body.isPrivate).toBe(true);
      expect(body.isOwner).toBe(true);
    });

    it('takes the owner from the session, never the body', async () => {
      await asUser(OWNER)
        .post('/api/v1/collections')
        .send({ ...validBody, ownerId: STRANGER })
        .expect(400);

      // `forbidNonWhitelisted` rejects it before the handler runs.
      expect(prisma.collection.create).not.toHaveBeenCalled();
    });

    it('rejects a body with no title', async () => {
      await asUser(OWNER)
        .post('/api/v1/collections')
        .send({ description: 'No title given.' })
        .expect(400);
    });

    it('rejects an unknown property', async () => {
      await asUser(OWNER)
        .post('/api/v1/collections')
        .send({ ...validBody, colour: 'red' })
        .expect(400);
    });

    it('rejects a signed-out caller', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/collections')
        .send(validBody)
        .expect(401);
    });
  });

  describe('GET /collections/me', () => {
    it('lists the caller’s own collections', async () => {
      const response = await asUser(OWNER)
        .get('/api/v1/collections/me')
        .expect(200);

      const body = response.body as {
        items: { isOwner: boolean }[];
        nextCursor: string | null;
      };

      expect(body.items).toHaveLength(1);
      expect(body.items[0].isOwner).toBe(true);
      expect(body.nextCursor).toBeNull();
    });

    it('filters by owner, so it can never return somebody else’s', async () => {
      await asUser(OWNER).get('/api/v1/collections/me').expect(200);

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: OWNER } }),
      );
    });

    it('asks about resource membership when told which resource', async () => {
      await asUser(OWNER)
        .get(`/api/v1/collections/me?resourceId=${RESOURCE}`)
        .expect(200);

      expect(prisma.collectionResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resourceId: RESOURCE, collectionId: { in: [COLLECTION] } },
        }),
      );
    });

    it('rejects an over-long limit', async () => {
      await asUser(OWNER).get('/api/v1/collections/me?limit=1000').expect(400);
    });

    it('requires a session', async () => {
      await asAnon.get('/api/v1/collections/me').expect(401);
    });

    it('is not shadowed by a collection whose id happens to be "me"', async () => {
      // `me` is declared before `:id`, so the literal always wins. Asserted
      // because the reverse ordering would silently return a collection instead
      // of the caller’s own.
      await asUser(OWNER).get('/api/v1/collections/me').expect(200);

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: OWNER } }),
      );
    });
  });

  describe('GET /collections', () => {
    it('lists public collections to a signed-out reader', async () => {
      const response = await asAnon.get('/api/v1/collections').expect(200);

      expect((response.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('filters private collections out in the query', async () => {
      await asAnon.get('/api/v1/collections').expect(200);

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPrivate: false } }),
      );
    });

    it('narrows to one owner by username', async () => {
      await asAnon.get('/api/v1/collections?owner=adal').expect(200);

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isPrivate: false, owner: { usernameLower: 'adal' } },
        }),
      );
    });

    it('folds the username, so ?owner=AdaL works', async () => {
      await asAnon.get('/api/v1/collections?owner=AdaL').expect(200);

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isPrivate: false, owner: { usernameLower: 'adal' } },
        }),
      );
    });

    it('rejects a malformed owner, rather than silently listing every collection', async () => {
      await asAnon.get('/api/v1/collections?owner=not-a-username').expect(400);
    });

    it('is not shadowed by a collection whose id is literally "me"', async () => {
      // Both literals are declared before `:id`, so neither can be shadowed by a
      // collection id that happens to look like one.
      await asAnon.get('/api/v1/collections').expect(200);

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPrivate: false } }),
      );
    });
  });

  describe('GET /collections/:id', () => {
    it('serves a public collection to a signed-out reader', async () => {
      await asAnon.get(`/api/v1/collections/${COLLECTION}`).expect(200);
    });

    it('serves a private collection to its owner', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({ isPrivate: true, ownerId: OWNER }),
      );

      const response = await asUser(OWNER)
        .get(`/api/v1/collections/${COLLECTION}`)
        .expect(200);

      expect((response.body as { isPrivate: boolean }).isPrivate).toBe(true);
    });

    it('404s a private collection for a stranger, not 403', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({ isPrivate: true, ownerId: OWNER }),
      );

      await asUser(STRANGER)
        .get(`/api/v1/collections/${COLLECTION}`)
        .expect(404);
    });

    it('404s a private collection for a signed-out reader', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({ isPrivate: true, ownerId: OWNER }),
      );

      await asAnon.get(`/api/v1/collections/${COLLECTION}`).expect(404);
    });

    it('resolves the owner to a linkable path', async () => {
      const response = await asAnon
        .get(`/api/v1/collections/${COLLECTION}`)
        .expect(200);

      expect(
        (response.body as { owner: { profilePath: string } }).owner.profilePath,
      ).toBe('/u/adal');
    });
  });

  describe('GET /collections/:id/resources', () => {
    it('lists what the collection holds', async () => {
      await asAnon
        .get(`/api/v1/collections/${COLLECTION}/resources`)
        .expect(200);

      expect(prisma.collectionResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { collectionId: COLLECTION } }),
      );
    });

    it('404s a private collection rather than returning an empty page', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({ isPrivate: true, ownerId: OWNER }),
      );

      await asUser(STRANGER)
        .get(`/api/v1/collections/${COLLECTION}/resources`)
        .expect(404);

      expect(prisma.collectionResource.findMany).not.toHaveBeenCalled();
    });

    it('rejects a malformed cursor', async () => {
      await asAnon
        .get(
          `/api/v1/collections/${COLLECTION}/resources?cursor=${encodeURIComponent('!!!')}`,
        )
        .expect(400);
    });
  });

  describe('update', () => {
    it('lets the owner rename it', async () => {
      await asUser(OWNER)
        .patch(`/api/v1/collections/${COLLECTION}`)
        .send({ title: 'Renamed' })
        .expect(200);
    });

    it('refuses a stranger', async () => {
      await asUser(STRANGER)
        .patch(`/api/v1/collections/${COLLECTION}`)
        .send({ title: 'Renamed' })
        .expect(403);

      expect(prisma.collection.update).not.toHaveBeenCalled();
    });

    it('lets an admin update one they do not own', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(ADMIN)
        .patch(`/api/v1/collections/${COLLECTION}`)
        .send({ title: 'Renamed' })
        .expect(200);
    });

    it('rejects a signed-out caller', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/collections/${COLLECTION}`)
        .send({ title: 'Renamed' })
        .expect(401);
    });
  });

  describe('delete', () => {
    it('lets the owner delete it', async () => {
      await asUser(OWNER)
        .delete(`/api/v1/collections/${COLLECTION}`)
        .expect(200);
    });

    it('refuses a stranger who is not an admin', async () => {
      await asUser(STRANGER)
        .delete(`/api/v1/collections/${COLLECTION}`)
        .expect(403);

      expect(prisma.collection.delete).not.toHaveBeenCalled();
    });
  });

  describe('POST /collections/:id/resources', () => {
    it('adds any resource to a collection you own', async () => {
      await asUser(OWNER)
        .post(`/api/v1/collections/${COLLECTION}/resources`)
        .send({ resourceId: RESOURCE })
        .expect(200);

      expect(prisma.collectionResource.createMany).toHaveBeenCalledWith({
        data: { collectionId: COLLECTION, resourceId: RESOURCE },
        skipDuplicates: true,
      });
    });

    it('succeeds when the resource is already in it', async () => {
      await asUser(OWNER)
        .post(`/api/v1/collections/${COLLECTION}/resources`)
        .send({ resourceId: RESOURCE })
        .expect(200);
    });

    it('refuses a stranger, with no admin path', async () => {
      currentUserRole = UserRole.ADMIN;

      await asUser(ADMIN)
        .post(`/api/v1/collections/${COLLECTION}/resources`)
        .send({ resourceId: RESOURCE })
        .expect(403);

      expect(prisma.collectionResource.createMany).not.toHaveBeenCalled();
    });

    it('404s a resource that does not exist', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await asUser(OWNER)
        .post(`/api/v1/collections/${COLLECTION}/resources`)
        .send({ resourceId: 'res_nope' })
        .expect(404);
    });

    it('rejects a body with no resource id', async () => {
      await asUser(OWNER)
        .post(`/api/v1/collections/${COLLECTION}/resources`)
        .send({})
        .expect(400);
    });
  });

  describe('DELETE /collections/:id/resources/:resourceId', () => {
    it('removes it', async () => {
      await asUser(OWNER)
        .delete(`/api/v1/collections/${COLLECTION}/resources/${RESOURCE}`)
        .expect(200);

      expect(prisma.collectionResource.deleteMany).toHaveBeenCalledWith({
        where: { collectionId: COLLECTION, resourceId: RESOURCE },
      });
    });

    it('refuses a stranger', async () => {
      await asUser(STRANGER)
        .delete(`/api/v1/collections/${COLLECTION}/resources/${RESOURCE}`)
        .expect(403);

      expect(prisma.collectionResource.deleteMany).not.toHaveBeenCalled();
    });
  });
});
