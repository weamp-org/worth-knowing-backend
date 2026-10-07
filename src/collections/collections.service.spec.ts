import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';

import { CollectionsService } from './collections.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/enums';
import { encodeCursor } from '../pagination/cursor.util';

const OWNER = 'user_owner';
const STRANGER = 'user_stranger';
const COLLECTION = 'col_1';
const RESOURCE = 'res_1';

/** A row shaped like the `collectionInclude` read, before it is flattened. */
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

/** A resource row shaped like the `resourceInclude` read. */
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
    contributor: {
      id: 'user_contributor',
      name: 'Grace Hopper',
      imageUrl: null,
      username: 'grace',
      usernameLower: 'grace',
      isProfilePrivate: false,
    },
    tags: [],
    // A collection's contents go through the same `toResourceResponse` as every
    // other public resource read, so this fixture carries the selected count too.
    _count: { savedResources: 0 },
    ...overrides,
  };
}

describe('CollectionsService', () => {
  let service: CollectionsService;
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionsService,
        {
          provide: PrismaService,
          useValue: {
            collection: {
              create: jest.fn().mockResolvedValue(collectionRow()),
              // An empty page by default, so nothing has to opt out of an
              // unexpected row.
              findMany: jest.fn().mockResolvedValue([]),
              findUnique: jest.fn().mockResolvedValue(collectionRow()),
              update: jest.fn().mockResolvedValue(collectionRow()),
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
            // No role by default, so the admin branch stays out of the way of
            // every other test in this file.
            user: { findUnique: jest.fn().mockResolvedValue(null) },
          },
        },
      ],
    }).compile();

    service = module.get(CollectionsService);
    prisma = module.get(PrismaService);
  });

  const createData = (): Record<string, unknown> => {
    const [[arg]] = prisma.collection.create.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    return arg.data;
  };

  const updateData = (): Record<string, unknown> => {
    const [[arg]] = prisma.collection.update.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    return arg.data;
  };

  describe('create', () => {
    it('creates a private collection when visibility is not stated', async () => {
      prisma.collection.create.mockResolvedValue(
        collectionRow({ isPrivate: true }),
      );

      const result = await service.create({ title: 'Reading list' }, OWNER);

      // Left to the column default rather than passed explicitly, so the DTO and
      // the schema cannot drift into disagreeing about what private means.
      expect('isPrivate' in createData()).toBe(false);
      expect(result.isPrivate).toBe(true);
    });

    it('passes an explicit visibility through', async () => {
      prisma.collection.create.mockResolvedValue(
        collectionRow({ isPrivate: false }),
      );

      const result = await service.create(
        { title: 'Reading list', isPrivate: false },
        OWNER,
      );

      expect(createData().isPrivate).toBe(false);
      expect(result.isPrivate).toBe(false);
    });

    it('connects the owner rather than writing a foreign key', async () => {
      await service.create({ title: 'Reading list' }, OWNER);

      expect(createData().owner).toEqual({ connect: { id: OWNER } });
    });

    it('reports the creator as the owner', async () => {
      const result = await service.create({ title: 'Reading list' }, OWNER);

      expect(result.isOwner).toBe(true);
    });
  });

  describe('findPublic', () => {
    it('filters private collections out in the query, not afterwards', async () => {
      await service.findPublic();

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPrivate: false } }),
      );
    });

    it('narrows to one owner by username', async () => {
      await service.findPublic('adal');

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isPrivate: false, owner: { usernameLower: 'adal' } },
        }),
      );
    });

    it('reports containsResource false, since no resource was asked about', async () => {
      prisma.collection.findMany.mockResolvedValue([collectionRow()]);

      const page = await service.findPublic();

      expect(page.items[0].containsResource).toBe(false);
    });

    it('flags the viewer as the owner when they are', async () => {
      prisma.collection.findMany.mockResolvedValue([collectionRow()]);

      const page = await service.findPublic(
        undefined,
        undefined,
        undefined,
        OWNER,
      );

      expect(page.items[0].isOwner).toBe(true);
    });

    it('pages with the same total order as the owner’s own list', async () => {
      await service.findPublic();

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });
  });

  describe('findOne', () => {
    it('404s a private collection for anyone but its owner', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({ isPrivate: true, ownerId: OWNER }),
      );

      await expect(service.findOne(COLLECTION, STRANGER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('serves a private collection to its owner', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({ isPrivate: true, ownerId: OWNER }),
      );

      const result = await service.findOne(COLLECTION, OWNER);

      expect(result.isOwner).toBe(true);
    });

    it('serves a public collection to a stranger, flagged as not theirs', async () => {
      const result = await service.findOne(COLLECTION, STRANGER);

      expect(result.isOwner).toBe(false);
      expect(result.isPrivate).toBe(false);
    });

    it('answers an unknown id with the same message a private one gets', async () => {
      prisma.collection.findUnique.mockResolvedValue(null);

      await expect(service.findOne('col_nope', STRANGER)).rejects.toThrow(
        'Collection col_nope not found',
      );
    });

    it('flattens the owner summary and drops the fields only it needs', async () => {
      const result = await service.findOne(COLLECTION, STRANGER);

      expect(result.owner).toEqual({
        name: 'Ada Lovelace',
        imageUrl: null,
        profilePath: '/u/adal',
      });
    });

    it('leaves the owner null rather than inventing a placeholder', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({ owner: null }),
      );

      const result = await service.findOne(COLLECTION, STRANGER);

      expect(result.owner).toBeNull();
    });

    it('gives an unlinked owner a null profilePath rather than a broken link', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({
          owner: {
            name: 'Ada Lovelace',
            imageUrl: null,
            username: 'AdaL',
            usernameLower: 'adal',
            isProfilePrivate: true,
          },
        }),
      );

      const result = await service.findOne(COLLECTION, STRANGER);

      expect(result.owner?.profilePath).toBeNull();
    });

    it('falls back to the claimed handle when there is no Clerk name', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({
          owner: {
            name: null,
            imageUrl: null,
            username: 'AdaL',
            usernameLower: 'adal',
            isProfilePrivate: false,
          },
        }),
      );

      const result = await service.findOne(COLLECTION, STRANGER);

      expect(result.owner?.name).toBe('AdaL');
    });
  });

  describe('findMine', () => {
    it('pages with a total order, so a cursor cannot skip or repeat', async () => {
      await service.findMine(OWNER);

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerId: OWNER },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('asks for one row over the page, so hasMore needs no COUNT(*)', async () => {
      await service.findMine(OWNER, undefined, 5);

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 6 }),
      );
    });

    it('trims the extra row and reports the cursor from the last kept one', async () => {
      prisma.collection.findMany.mockResolvedValue([
        collectionRow({ id: 'col_1' }),
        collectionRow({ id: 'col_2' }),
        collectionRow({ id: 'col_3' }),
      ]);

      const page = await service.findMine(OWNER, undefined, 2);

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe(encodeCursor('col_2'));
    });

    it('returns a null cursor on the last page', async () => {
      prisma.collection.findMany.mockResolvedValue([collectionRow()]);

      const page = await service.findMine(OWNER);

      expect(page.nextCursor).toBeNull();
    });

    it('scopes the cursor to the page it came from', async () => {
      await service.findMine(
        OWNER,
        undefined,
        undefined,
        encodeCursor('col_9'),
      );

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: 'col_9' },
          skip: 1,
        }),
      );
    });

    it('turns a cursor row that no longer exists into a 400', async () => {
      const missingRow = new Prisma.PrismaClientKnownRequestError('gone', {
        code: 'P2025',
        clientVersion: 'test',
      });
      prisma.collection.findMany.mockRejectedValue(missingRow);

      await expect(
        service.findMine(OWNER, undefined, undefined, encodeCursor('col_gone')),
      ).rejects.toThrow(BadRequestException);
    });

    it('skips the membership query entirely when no resource was asked about', async () => {
      prisma.collection.findMany.mockResolvedValue([collectionRow()]);

      await service.findMine(OWNER);

      expect(prisma.collectionResource.findMany).not.toHaveBeenCalled();
    });

    it('asks about membership for the whole page in one query, not one per row', async () => {
      prisma.collection.findMany.mockResolvedValue([
        collectionRow({ id: 'col_1' }),
        collectionRow({ id: 'col_2' }),
      ]);
      prisma.collectionResource.findMany.mockResolvedValue([
        { collectionId: 'col_2' },
      ]);

      const page = await service.findMine(OWNER, RESOURCE);

      expect(prisma.collectionResource.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.collectionResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            resourceId: RESOURCE,
            collectionId: { in: ['col_1', 'col_2'] },
          },
        }),
      );
      expect(page.items.map((c) => c.containsResource)).toEqual([false, true]);
    });

    it('reports false for every row when a resource is not asked about', async () => {
      prisma.collection.findMany.mockResolvedValue([collectionRow()]);
      // A row that would match, so only the absence of the parameter can explain
      // the `false`.
      prisma.collectionResource.findMany.mockResolvedValue([
        { collectionId: COLLECTION },
      ]);

      const page = await service.findMine(OWNER);

      expect(page.items[0].containsResource).toBe(false);
    });

    it('does not query for membership on an empty page', async () => {
      const page = await service.findMine(OWNER, RESOURCE);

      expect(prisma.collectionResource.findMany).not.toHaveBeenCalled();
      expect(page.items).toEqual([]);
    });

    it('always reports the caller as the owner', async () => {
      prisma.collection.findMany.mockResolvedValue([collectionRow()]);

      const page = await service.findMine(OWNER);

      expect(page.items[0].isOwner).toBe(true);
    });
  });

  describe('listResources', () => {
    it('pages the join table, not the resources, so the order is when they were collected', async () => {
      await service.listResources(COLLECTION);

      expect(prisma.collectionResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { collectionId: COLLECTION },
          orderBy: [{ addedAt: 'desc' }, { resourceId: 'desc' }],
        }),
      );
    });

    it('checks visibility before it reads, so a private collection is not an empty page', async () => {
      prisma.collection.findUnique.mockResolvedValue(
        collectionRow({ isPrivate: true, ownerId: OWNER }),
      );

      await expect(service.listResources(COLLECTION, STRANGER)).rejects.toThrow(
        NotFoundException,
      );

      expect(prisma.collectionResource.findMany).not.toHaveBeenCalled();
    });

    it('cursors on the compound key, because a resource id alone is not unique', async () => {
      await service.listResources(
        COLLECTION,
        undefined,
        undefined,
        encodeCursor(RESOURCE),
      );

      expect(prisma.collectionResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: {
            collectionId_resourceId: {
              collectionId: COLLECTION,
              resourceId: RESOURCE,
            },
          },
          skip: 1,
        }),
      );
    });

    it('carries only the resource half in the cursor, since the path has the rest', async () => {
      prisma.collectionResource.findMany.mockResolvedValue([
        { resourceId: 'res_a', resource: resourceRow({ id: 'res_a' }) },
        { resourceId: 'res_b', resource: resourceRow({ id: 'res_b' }) },
        { resourceId: 'res_c', resource: resourceRow({ id: 'res_c' }) },
      ]);

      const page = await service.listResources(COLLECTION, undefined, 2);

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe(encodeCursor('res_b'));
    });

    it('redacts an anonymous resource, so a public collection does not deanonymize it', async () => {
      prisma.collectionResource.findMany.mockResolvedValue([
        {
          resourceId: RESOURCE,
          resource: resourceRow({ isAnonymous: true }),
        },
      ]);

      const page = await service.listResources(COLLECTION, STRANGER);

      expect(page.items[0].contributor).toBeNull();
      expect(page.items[0].contributorId).toBeNull();
      // Still flagged, so a client can word it as anonymous rather than as a
      // deleted contributor.
      expect(page.items[0].isAnonymous).toBe(true);
    });

    it('does not redact an anonymous resource for its own contributor', async () => {
      prisma.collectionResource.findMany.mockResolvedValue([
        {
          resourceId: RESOURCE,
          resource: resourceRow({
            isAnonymous: true,
            contributorId: 'user_contributor',
          }),
        },
      ]);

      const page = await service.listResources(COLLECTION, 'user_contributor');

      expect(page.items[0].contributor?.name).toBe('Grace Hopper');
    });

    it('turns a cursor row that no longer exists into a 400', async () => {
      const missingRow = new Prisma.PrismaClientKnownRequestError('gone', {
        code: 'P2025',
        clientVersion: 'test',
      });
      prisma.collectionResource.findMany.mockRejectedValue(missingRow);

      await expect(
        service.listResources(
          COLLECTION,
          undefined,
          undefined,
          encodeCursor('res_gone'),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('lets the owner rename it', async () => {
      prisma.collection.findUnique.mockResolvedValue({
        ...collectionRow(),
        ownerId: OWNER,
      });

      await expect(
        service.update(COLLECTION, { title: 'Renamed' }, OWNER),
      ).resolves.toBeDefined();
    });

    it('refuses a stranger who is not an admin', async () => {
      await expect(
        service.update(COLLECTION, { title: 'Renamed' }, STRANGER),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets an admin update a collection they do not own', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.ADMIN });

      await expect(
        service.update(COLLECTION, { title: 'Renamed' }, STRANGER),
      ).resolves.toBeDefined();
    });

    it('404s a collection that does not exist', async () => {
      prisma.collection.findUnique.mockResolvedValue(null);

      await expect(
        service.update('col_nope', { title: 'Renamed' }, OWNER),
      ).rejects.toThrow(NotFoundException);
    });

    it('leaves the description alone when the update did not mention it', async () => {
      await service.update(COLLECTION, { title: 'Renamed' }, OWNER);

      expect(updateData()).toEqual({ title: 'Renamed' });
      expect('description' in updateData()).toBe(false);
    });

    it('clears the description when it is explicitly null', async () => {
      // "Remove the paragraph I wrote" has to be possible, and `null` is the
      // only way to ask for it.
      await service.update(
        COLLECTION,
        { description: null as unknown as string },
        OWNER,
      );

      expect('description' in updateData()).toBe(true);
    });

    it('writes a description when one is given', async () => {
      await service.update(
        COLLECTION,
        { description: 'A new framing.' },
        OWNER,
      );

      expect(updateData()).toEqual({ description: 'A new framing.' });
    });

    it('does not carry the title into the update when only visibility changed', async () => {
      await service.update(COLLECTION, { isPrivate: false }, OWNER);

      expect(updateData()).toEqual({ isPrivate: false });
    });
  });

  describe('remove', () => {
    it('lets the owner delete it', async () => {
      await expect(service.remove(COLLECTION, OWNER)).resolves.toBeDefined();
      expect(prisma.collection.delete).toHaveBeenCalledWith({
        where: { id: COLLECTION },
      });
    });

    it('refuses a stranger who is not an admin', async () => {
      await expect(service.remove(COLLECTION, STRANGER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.collection.delete).not.toHaveBeenCalled();
    });

    it('lets an admin delete a collection they do not own', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.ADMIN });

      await expect(service.remove(COLLECTION, STRANGER)).resolves.toBeDefined();
    });

    it('404s rather than 403s for a stranger, so existence stays unconfirmed', async () => {
      prisma.collection.findUnique.mockResolvedValue(null);

      await expect(service.remove('col_nope', STRANGER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('addResource', () => {
    it('adds any resource, not only the caller’s own', async () => {
      await service.addResource(COLLECTION, RESOURCE, OWNER);

      expect(prisma.collectionResource.createMany).toHaveBeenCalledWith({
        data: { collectionId: COLLECTION, resourceId: RESOURCE },
        skipDuplicates: true,
      });
    });

    it('lets the resource that is already in stay a no-op rather than a conflict', async () => {
      // `skipDuplicates` is what makes a double click succeed, and a
      // read-then-write check would not: two clicks landing together would
      // produce one row and one P2002.
      await expect(
        service.addResource(COLLECTION, RESOURCE, OWNER),
      ).resolves.toBeDefined();
    });

    it('refuses a stranger, with no admin path', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.ADMIN });

      await expect(
        service.addResource(COLLECTION, RESOURCE, STRANGER),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.collectionResource.createMany).not.toHaveBeenCalled();
    });

    it('404s a resource that does not exist, rather than letting the FK 500', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(
        service.addResource(COLLECTION, 'res_nope', OWNER),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.collectionResource.createMany).not.toHaveBeenCalled();
    });

    it('returns the collection with a refreshed count', async () => {
      prisma.collection.findUnique
        .mockResolvedValueOnce({ ...collectionRow(), ownerId: OWNER })
        .mockResolvedValueOnce(collectionRow({ _count: { resources: 3 } }));

      const result = await service.addResource(COLLECTION, RESOURCE, OWNER);

      expect(result.resourceCount).toBe(3);
    });
  });

  describe('removeResource', () => {
    it('removes it', async () => {
      await service.removeResource(COLLECTION, RESOURCE, OWNER);

      expect(prisma.collectionResource.deleteMany).toHaveBeenCalledWith({
        where: { collectionId: COLLECTION, resourceId: RESOURCE },
      });
    });

    it('succeeds when the resource was not in the collection, since that is the state asked for', async () => {
      prisma.collectionResource.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        service.removeResource(COLLECTION, RESOURCE, OWNER),
      ).resolves.toBeDefined();
    });

    it('does not require the resource itself to still exist', async () => {
      // Its join rows would have cascaded away with it, and the caller's request
      // has still been honoured — so this is not the 404 that `addResource` gives.
      await service.removeResource(COLLECTION, 'res_deleted', OWNER);

      expect(prisma.resource.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a stranger', async () => {
      await expect(
        service.removeResource(COLLECTION, RESOURCE, STRANGER),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.collectionResource.deleteMany).not.toHaveBeenCalled();
    });
  });
});
