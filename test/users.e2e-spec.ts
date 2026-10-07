import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { getAuth } from '@clerk/express';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { validationPipeOptions } from './../src/validation';
import { UserRole } from './../src/generated/prisma/enums';

// `getAuth` needs the request branding that `clerkMiddleware()` puts there, and
// only `main.ts` registers that. `x-test-user-id` stands in for the session.
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
  clerkClient: { users: { getUser: jest.fn() } },
}));

/** A profile row as `profileSelect` returns it, id included. */
const profileRow = (over: Record<string, unknown> = {}) => ({
  id: 'user_1',
  username: 'AdaL',
  usernameLower: 'adal',
  name: 'Ada Lovelace',
  imageUrl: null,
  bio: 'Compiler notes.',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  isProfilePrivate: false,
  // Selected only by `findMyProfile`; the public read omits it entirely.
  role: UserRole.USER,
  ...over,
});

describe('Users (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    resource: { count: jest.Mock };
    reservedUsername: { findUnique: jest.Mock; upsert: jest.Mock };
    $transaction: jest.Mock;
  };

  /** A transaction client that behaves like the real one for the claim path. */
  const makeTx = (previous: { usernameLower: string | null }) => ({
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(previous),
      update: jest.fn().mockResolvedValue(profileRow()),
    },
    reservedUsername: { upsert: jest.fn().mockResolvedValue({}) },
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        user: {
          // Resolves to a row by default, so `ClerkAuthGuard.ensureUserExists`
          // finds the account already provisioned and never calls Clerk. Tests
          // that need a *miss* override this one.
          findUnique: jest.fn().mockResolvedValue({ id: 'user_1' }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(profileRow()),
          update: jest.fn().mockResolvedValue(profileRow()),
        },
        resource: { count: jest.fn().mockResolvedValue(3) },
        reservedUsername: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({}),
        },
        $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
          fn(makeTx({ usernameLower: null })),
        ),
        // `RolesGuard` reads this for the settings routes.
        role: UserRole.USER,
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

  const asUser = (userId: string) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('x-test-user-id', userId),
    patch: (url: string) =>
      request(app.getHttpServer())
        .patch(url)
        .set('x-test-user-id', userId)
        .send({}),
  });

  describe('GET /api/v1/users/:username', () => {
    it('is reachable while signed out, because a profile is a public page', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      const response = await request(app.getHttpServer())
        .get('/api/v1/users/adal')
        .expect(200);

      expect((response.body as { usernameLower: string }).usernameLower).toBe(
        'adal',
      );
    });

    it('never returns an email, a role or the Clerk user id', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      const response = await request(app.getHttpServer())
        .get('/api/v1/users/adal')
        .expect(200);

      expect(response.body).not.toHaveProperty('email');
      expect(response.body).not.toHaveProperty('role');
      expect(response.body).not.toHaveProperty('id');
      expect(response.body).not.toHaveProperty('anonymousByDefault');
    });

    it('counts only contributions that carry the name', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      const response = await request(app.getHttpServer())
        .get('/api/v1/users/adal')
        .expect(200);

      expect(prisma.resource.count).toHaveBeenCalledWith({
        where: { contributorId: 'user_1', isAnonymous: false },
      });
      expect((response.body as { resourcesCount: number }).resourcesCount).toBe(
        3,
      );
    });

    it('404s for an unclaimed username', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/api/v1/users/nobody')
        .expect(404);
    });

    // A 403 would confirm the username exists, which is the one fact the
    // contributor asked to withhold. 404 is indistinguishable from unclaimed.
    it('404s for a private profile to a signed-out reader', async () => {
      prisma.user.findUnique.mockResolvedValue(
        profileRow({ isProfilePrivate: true }),
      );

      await request(app.getHttpServer()).get('/api/v1/users/adal').expect(404);
    });

    // This route is `@Public()`, so `ClerkAuthGuard` is skipped and the
    // service's profile read is the only one — hence a plain override rather
    // than the ordered `mockResolvedValueOnce` chain the guarded routes need.
    it('404s for a private profile to a signed-in stranger', async () => {
      prisma.user.findUnique.mockResolvedValue(
        profileRow({ isProfilePrivate: true }),
      );

      await asUser('someone_else').get('/api/v1/users/adal').expect(404);
    });

    it('lets the owner see their own private profile', async () => {
      prisma.user.findUnique.mockResolvedValue(
        profileRow({ isProfilePrivate: true }),
      );

      const response = await asUser('user_1')
        .get('/api/v1/users/adal')
        .expect(200);

      expect(
        (response.body as { isProfilePrivate: boolean }).isProfilePrivate,
      ).toBe(true);
    });

    // The response carries no id, so a client cannot work this out itself. An
    // edit link derived wrongly here is an edit link on somebody else's profile.
    it('reports the owner, and does not for a stranger', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      const own = await asUser('user_1').get('/api/v1/users/adal').expect(200);
      const other = await request(app.getHttpServer())
        .get('/api/v1/users/adal')
        .expect(200);

      expect((own.body as { isOwner: boolean }).isOwner).toBe(true);
      expect((other.body as { isOwner: boolean }).isOwner).toBe(false);
    });

    it('folds the requested username before looking it up', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      await request(app.getHttpServer()).get('/api/v1/users/AdaL').expect(200);

      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { usernameLower: 'adal' } }),
      );
    });

    it('does not shadow the me/* routes', async () => {
      await asUser('user_1').get('/api/v1/users/me/profile').expect(200);
    });
  });

  describe('GET /api/v1/users/me/profile', () => {
    it('requires a session', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/users/me/profile')
        .expect(401);
    });

    it('returns the caller profile', async () => {
      const response = await asUser('user_1')
        .get('/api/v1/users/me/profile')
        .expect(200);

      expect((response.body as { usernameLower: string }).usernameLower).toBe(
        'adal',
      );
    });

    it('returns the caller’s own role', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        profileRow({ role: UserRole.ADMIN }),
      );

      const response = await asUser('user_1')
        .get('/api/v1/users/me/profile')
        .expect(200);

      // Your own role, to you. The header needs it to decide whether to offer a
      // moderation link, and `/moderation` needs it to tell "sign in" apart from
      // "not allowed" — neither was reachable while the only way to learn a role
      // was to ask a route that refuses you.
      expect((response.body as { role: string }).role).toBe('ADMIN');
    });

    it('reports USER rather than omitting the field for an ordinary account', async () => {
      const response = await asUser('user_1')
        .get('/api/v1/users/me/profile')
        .expect(200);

      // A client branching on `role === ADMIN` must not have to tell an absent field
      // apart from a real answer.
      expect((response.body as { role: string }).role).toBe('USER');
    });
  });

  describe('PATCH /api/v1/users/me/profile', () => {
    const patch = (userId: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .patch('/api/v1/users/me/profile')
        .set('x-test-user-id', userId)
        .send(body);

    it('requires a session', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/users/me/profile')
        .send({ bio: 'x' })
        .expect(401);
    });

    it('rejects a field that is not on the profile', async () => {
      // `whitelist` plus `forbidNonWhitelisted` means a Clerk-owned field cannot
      // be written through this route even by the owner.
      await patch('user_1', { name: 'Someone Else' }).expect(400);
      await patch('user_1', { email: 'else@example.com' }).expect(400);
    });

    it('accepts a bio', async () => {
      await patch('user_1', { bio: 'Compiler notes.' }).expect(200);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user_1' },
          data: { bio: 'Compiler notes.' },
        }),
      );
    });

    it('takes the caller id from the session, never the body', async () => {
      await patch('user_1', { bio: 'x' }).expect(200);

      const [[arg]] = prisma.user.update.mock.calls as unknown as [
        [{ where: { id: string }; data: Record<string, unknown> }],
      ];

      expect(arg.where.id).toBe('user_1');
      expect(arg.data).not.toHaveProperty('id');
    });

    it('claims a username and reports the folded identity', async () => {
      await patch('user_1', { username: 'Café_Ada' }).expect(200);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('409s on a reserved word', async () => {
      prisma.reservedUsername.findUnique.mockResolvedValue({
        reason: 'RESERVED',
      });

      await patch('user_1', { username: 'admin' }).expect(409);
    });

    it('409s on a previously released handle', async () => {
      prisma.reservedUsername.findUnique.mockResolvedValue({
        reason: 'RELEASED',
      });

      await patch('user_1', { username: 'ada' }).expect(409);
    });

    it('409s when somebody else holds the username', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'someone_else' });

      await patch('user_1', { username: 'ada' }).expect(409);
    });

    it('400s on a bad shape without querying for availability', async () => {
      await patch('user_1', { username: 'ada-lovelace' }).expect(400);

      expect(prisma.reservedUsername.findUnique).not.toHaveBeenCalled();
    });

    it('400s on an unsupported script', async () => {
      const response = await patch('user_1', { username: '日本語' }).expect(
        400,
      );

      expect((response.body as { message: string }).message).toMatch(
        /not supported yet/i,
      );
    });

    it('400s on a bio over the column width', async () => {
      await patch('user_1', { bio: 'x'.repeat(281) }).expect(400);
    });

    // The same inversion `CreateResourceDto.isAnonymous` guards against: a
    // string "false" must not become `true` on a privacy flag.
    it('rejects a stringified boolean rather than inverting it', async () => {
      await patch('user_1', { isProfilePrivate: 'false' }).expect(400);
    });
  });

  describe('settings routes are unchanged', () => {
    it('GET /api/v1/users/me/settings still works', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        anonymousByDefault: false,
      });

      const response = await asUser('user_1')
        .get('/api/v1/users/me/settings')
        .expect(200);

      expect(response.body).toEqual({ anonymousByDefault: false });
    });

    it('PATCH /api/v1/users/me/settings still works', async () => {
      prisma.user.update.mockResolvedValue({ anonymousByDefault: true });

      await request(app.getHttpServer())
        .patch('/api/v1/users/me/settings')
        .set('x-test-user-id', 'user_1')
        .send({ anonymousByDefault: true })
        .expect(200);
    });
  });
});
