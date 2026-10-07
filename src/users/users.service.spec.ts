import { Test, TestingModule } from '@nestjs/testing';

import { Prisma } from '../generated/prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/enums';

/** A profile row as `profileSelect` returns it, including the id. */
function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clerk_123',
    username: 'AdaL',
    usernameLower: 'adal',
    name: 'Ada Lovelace',
    imageUrl: null,
    bio: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    isProfilePrivate: false,
    // Selected only by `findMyProfile`. The public read omits it, and
    // `findMyProfile`'s own test asserts the difference.
    role: UserRole.USER,
    ...overrides,
  };
}

/** A P2002, as Prisma raises it when a unique index rejects a write. */
function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
  });
}

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUniqueOrThrow: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    resource: { count: jest.Mock };
    reservedUsername: { findUnique: jest.Mock; upsert: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUniqueOrThrow: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
            },
            resource: { count: jest.fn().mockResolvedValue(0) },
            reservedUsername: {
              findUnique: jest.fn().mockResolvedValue(null),
              upsert: jest.fn().mockResolvedValue({}),
            },
            // Interactive transactions hand the callback a client with the same
            // surface, which is what the claim path uses.
            $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
              fn({
                user: {
                  findUniqueOrThrow: jest.fn(),
                  update: jest.fn().mockResolvedValue(profileRow()),
                },
                reservedUsername: { upsert: jest.fn().mockResolvedValue({}) },
              }),
            ),
          },
        },
      ],
    }).compile();

    service = module.get(UsersService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findMySettings', () => {
    it('reads only the preferences, never the identity fields', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        anonymousByDefault: true,
      });

      const result = await service.findMySettings('clerk_123');

      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'clerk_123' },
        // A settings read must not drag back an email or a role.
        select: { anonymousByDefault: true },
      });
      expect(result).toEqual({ anonymousByDefault: true });
    });

    it('throws when the row is missing rather than inventing a default', async () => {
      prisma.user.findUniqueOrThrow.mockRejectedValue(new Error('Not found'));

      await expect(service.findMySettings('ghost')).rejects.toThrow();
    });
  });

  describe('updateMySettings', () => {
    it('writes the preference', async () => {
      prisma.user.update.mockResolvedValue({ anonymousByDefault: true });

      const result = await service.updateMySettings('clerk_123', {
        anonymousByDefault: true,
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'clerk_123' },
        data: { anonymousByDefault: true },
        select: { anonymousByDefault: true },
      });
      expect(result).toEqual({ anonymousByDefault: true });
    });

    // Spreading an absent key would send an explicit null to a non-nullable
    // column, which Prisma rejects.
    it('sends nothing when the body is empty', async () => {
      prisma.user.update.mockResolvedValue({ anonymousByDefault: false });

      await service.updateMySettings('clerk_123', {});

      const [[arg]] = prisma.user.update.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(arg.data).toEqual({});
    });

    it('takes the id from the argument, never from the payload', async () => {
      prisma.user.update.mockResolvedValue({ anonymousByDefault: false });

      await service.updateMySettings('clerk_123', {
        anonymousByDefault: false,
      });

      const [[arg]] = prisma.user.update.mock.calls as unknown as [
        [{ where: { id: string }; data: Record<string, unknown> }],
      ];
      expect(arg.where.id).toBe('clerk_123');
      expect(arg.data).not.toHaveProperty('id');
    });
  });

  describe('findMyProfile', () => {
    it('selects the public profile fields plus your own role, never the email', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(profileRow());

      await service.findMyProfile('clerk_123');

      const [[arg]] = prisma.user.findUniqueOrThrow.mock.calls as unknown as [
        [{ select: Record<string, unknown> }],
      ];

      expect(arg.select).not.toHaveProperty('email');
      expect(arg.select).not.toHaveProperty('anonymousByDefault');

      // Your own role is the one exception to the allowlist, and only here: the
      // header needs it to decide whether to offer a moderation link, and
      // `/moderation` needs it to tell "sign in" apart from "not allowed".
      expect(arg.select).toHaveProperty('role', true);
    });

    it('returns your own role', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        profileRow({ role: UserRole.ADMIN }),
      );

      const result = await service.findMyProfile('clerk_123');

      expect(result.role).toBe(UserRole.ADMIN);
    });

    it('reports USER by default rather than omitting the field', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(profileRow());

      const result = await service.findMyProfile('clerk_123');

      // A client branching on `role === ADMIN` must not have to distinguish an absent
      // field from a real answer.
      expect(result.role).toBe(UserRole.USER);
    });

    it('returns the row without the Clerk user id', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(profileRow());

      const result = await service.findMyProfile('clerk_123');

      // A profile is looked up by a public handle; the primary key next to it
      // invites being used as an identifier for what the profile does not show.
      expect(result).not.toHaveProperty('id');
      expect(result.usernameLower).toBe('adal');
    });

    it('counts only contributions that carry the name', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(profileRow());
      prisma.resource.count.mockResolvedValue(12);

      const result = await service.findMyProfile('clerk_123');

      expect(prisma.resource.count).toHaveBeenCalledWith({
        where: { contributorId: 'clerk_123', isAnonymous: false },
      });
      expect(result.resourcesCount).toBe(12);
    });

    // The response carries no id, so the client has no way to work this out.
    it('reports the caller as the owner', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(profileRow());

      const result = await service.findMyProfile('clerk_123');

      expect(result.isOwner).toBe(true);
    });
  });

  describe('findByUsername', () => {
    it('folds the requested username before looking it up', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      await service.findByUsername('AdaL');

      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { usernameLower: 'adal' } }),
      );
    });

    it('404s for an unclaimed username', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findByUsername('nobody')).rejects.toThrow(
        /No profile at/,
      );
    });

    // A 403 would confirm the username exists, which is the one fact the
    // contributor asked to withhold. 404 is indistinguishable from unclaimed.
    it('404s for a private profile to a stranger', async () => {
      prisma.user.findUnique.mockResolvedValue(
        profileRow({ isProfilePrivate: true }),
      );

      await expect(
        service.findByUsername('adal', 'someone_else'),
      ).rejects.toThrow(/No profile at/);
    });

    it('lets the owner see their own private profile', async () => {
      prisma.user.findUnique.mockResolvedValue(
        profileRow({ isProfilePrivate: true }),
      );

      const result = await service.findByUsername('adal', 'clerk_123');

      expect(result.usernameLower).toBe('adal');
      expect(result.isProfilePrivate).toBe(true);
    });

    it('reports the caller as not the owner on a public read', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      const result = await service.findByUsername('adal', 'someone_else');

      expect(result.isOwner).toBe(false);
    });

    it('reports no owner when nobody is signed in', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow());

      const result = await service.findByUsername('adal');

      expect(result.isOwner).toBe(false);
    });

    it('reports the owner on a profile write, which is always by the owner', async () => {
      prisma.user.update.mockResolvedValue(profileRow({ bio: 'Notes.' }));

      const result = await service.updateMyProfile('clerk_123', {
        bio: 'Notes.',
      });

      expect(result.isOwner).toBe(true);
    });

    it('shows a user with no Clerk name by the handle they claimed', async () => {
      prisma.user.findUnique.mockResolvedValue(profileRow({ name: null }));

      const result = await service.findByUsername('adal', 'clerk_123');

      // Never a placeholder. "Anonymous" used to be stored as somebody's name,
      // and it collided with the product's own anonymity wording.
      //
      // The *display* form of the handle, not the normalized one: "AdaL" keeps
      // the case the person chose, which is the whole reason there are two
      // columns.
      expect(result.name).toBe('AdaL');
      expect(result.name).not.toBe('Anonymous');
    });

    it('is null only for an account with neither a name nor a handle', async () => {
      prisma.user.findUnique.mockResolvedValue(
        profileRow({ name: null, username: null, usernameLower: null }),
      );

      const result = await service.findByUsername('adal', 'clerk_123');

      expect(result.name).toBeNull();
    });
  });

  describe('updateMyProfile', () => {
    it('writes a bio without touching the username', async () => {
      prisma.user.update.mockResolvedValue(
        profileRow({ bio: 'Compiler notes.' }),
      );

      const result = await service.updateMyProfile('clerk_123', {
        bio: 'Compiler notes.',
      });

      const [[arg]] = prisma.user.update.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];

      expect(arg.data).toEqual({ bio: 'Compiler notes.' });
      expect(arg.data).not.toHaveProperty('username');
      expect(result.bio).toBe('Compiler notes.');
    });

    it('omits a username that was not in the body, so a claimed one survives', async () => {
      prisma.user.update.mockResolvedValue(profileRow());

      await service.updateMyProfile('clerk_123', { bio: 'x' });

      const [[arg]] = prisma.user.update.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];

      expect(arg.data).not.toHaveProperty('usernameLower');
    });

    it('takes the id from the argument, never from the payload', async () => {
      prisma.user.update.mockResolvedValue(profileRow());

      await service.updateMyProfile('clerk_123', { bio: 'x' });

      const [[arg]] = prisma.user.update.mock.calls as unknown as [
        [{ where: { id: string }; data: Record<string, unknown> }],
      ];

      expect(arg.where.id).toBe('clerk_123');
      expect(arg.data).not.toHaveProperty('id');
    });

    it('stores the typed case for display and the folded form as the identity', async () => {
      const tx = {
        user: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ usernameLower: null }),
          update: jest.fn().mockResolvedValue(profileRow()),
        },
        reservedUsername: { upsert: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) =>
        fn(tx),
      );

      await service.updateMyProfile('clerk_123', { username: 'Café_Ada' });

      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { username: 'Cafe_Ada', usernameLower: 'cafe_ada' },
        }),
      );
    });

    it('rejects a reserved word as a conflict, not as "taken"', async () => {
      prisma.reservedUsername.findUnique.mockResolvedValue({
        reason: 'RESERVED',
      });

      await expect(
        service.updateMyProfile('clerk_123', { username: 'admin' }),
      ).rejects.toThrow(/reserved/i);
    });

    it('rejects a released handle as a conflict', async () => {
      prisma.reservedUsername.findUnique.mockResolvedValue({
        reason: 'RELEASED',
      });

      await expect(
        service.updateMyProfile('clerk_123', { username: 'ada' }),
      ).rejects.toThrow(/before/i);
    });

    it('rejects a username somebody else holds', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'someone_else' });

      await expect(
        service.updateMyProfile('clerk_123', { username: 'ada' }),
      ).rejects.toThrow(/already taken/i);
    });

    it('rejects an unsupported script with a message that is not about characters', async () => {
      await expect(
        service.updateMyProfile('clerk_123', { username: '日本語' }),
      ).rejects.toThrow(/not supported yet/i);
    });

    it('rejects a bad shape before touching the database', async () => {
      await expect(
        service.updateMyProfile('clerk_123', { username: 'a-b' }),
      ).rejects.toThrow(/3 to 24/);

      expect(prisma.reservedUsername.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    // Re-asserting the handle you already hold is not a change. Releasing it
    // here would make your own username permanently unclaimable by you.
    it('does not release a handle the caller already holds', async () => {
      const upsert = jest.fn();
      const tx = {
        user: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ usernameLower: 'ada' }),
          update: jest.fn().mockResolvedValue(profileRow()),
        },
        reservedUsername: { upsert },
      };
      prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) =>
        fn(tx),
      );

      await service.updateMyProfile('clerk_123', { username: 'Ada' });

      expect(upsert).not.toHaveBeenCalled();
    });

    it('releases the previous handle in the same transaction as the claim', async () => {
      const upsert = jest.fn().mockResolvedValue({});
      const update = jest.fn().mockResolvedValue(profileRow());
      const tx = {
        user: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ usernameLower: 'oldhandle' }),
          update,
        },
        reservedUsername: { upsert },
      };
      prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) =>
        fn(tx),
      );

      await service.updateMyProfile('clerk_123', { username: 'newhandle' });

      expect(upsert).toHaveBeenCalledWith({
        where: { usernameLower: 'oldhandle' },
        update: {},
        create: { usernameLower: 'oldhandle', reason: 'RELEASED' },
      });
      // Both writes inside one transaction, so there is no window in which the
      // old handle is claimable by anybody else.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('turns a lost race on the unique index into the same 409 as a real collision', async () => {
      const tx = {
        user: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ usernameLower: null }),
          update: jest.fn().mockRejectedValue(uniqueViolation()),
        },
        reservedUsername: { upsert: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) =>
        fn(tx),
      );

      await expect(
        service.updateMyProfile('clerk_123', { username: 'racy' }),
      ).rejects.toThrow(/already taken/i);
    });

    it('does not swallow a real database failure as a 409', async () => {
      const tx = {
        user: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ usernameLower: null }),
          update: jest.fn().mockRejectedValue(new Error('connection lost')),
        },
        reservedUsername: { upsert: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) =>
        fn(tx),
      );

      await expect(
        service.updateMyProfile('clerk_123', { username: 'racy' }),
      ).rejects.toThrow('connection lost');
    });

    it('applies the remaining fields even when a username is claimed', async () => {
      const tx = {
        user: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ usernameLower: null }),
          update: jest.fn().mockResolvedValue(profileRow()),
        },
        reservedUsername: { upsert: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) =>
        fn(tx),
      );
      prisma.user.update.mockResolvedValue(
        profileRow({ bio: 'Compiler notes.', isProfilePrivate: true }),
      );

      const result = await service.updateMyProfile('clerk_123', {
        username: 'adal',
        bio: 'Compiler notes.',
        isProfilePrivate: true,
      });

      expect(result.bio).toBe('Compiler notes.');
      expect(result.isProfilePrivate).toBe(true);
    });
  });
});
