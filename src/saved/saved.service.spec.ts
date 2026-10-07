import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';

import { SavedService } from './saved.service';
import { PrismaService } from '../prisma/prisma.service';
import { encodeCursor } from '../pagination/cursor.util';

const USER = 'user_1';
const RESOURCE = 'res_1';

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
    _count: { savedResources: 3 },
    ...overrides,
  };
}

describe('SavedService', () => {
  let service: SavedService;
  let prisma: {
    resource: { findUnique: jest.Mock };
    savedResource: {
      createMany: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavedService,
        {
          provide: PrismaService,
          useValue: {
            resource: {
              findUnique: jest.fn().mockResolvedValue(resourceRow()),
            },
            savedResource: {
              createMany: jest.fn().mockResolvedValue({ count: 1 }),
              deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
              findMany: jest.fn().mockResolvedValue([]),
              findUnique: jest.fn().mockResolvedValue(null),
            },
          },
        },
      ],
    }).compile();

    service = module.get(SavedService);
    prisma = module.get(PrismaService);
  });

  describe('findMine', () => {
    it('pages the join table, not the resources', async () => {
      await service.findMine(USER);

      expect(prisma.savedResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER },
          orderBy: [{ savedAt: 'desc' }, { resourceId: 'desc' }],
        }),
      );
    });

    it('scopes to the caller, so it can never return somebody else’s', async () => {
      await service.findMine(USER);

      expect(prisma.savedResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER } }),
      );
    });

    it('asks for one row over the page, so hasMore needs no COUNT(*)', async () => {
      await service.findMine(USER, 5);

      expect(prisma.savedResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 6 }),
      );
    });

    it('trims the extra row and cursors on the last kept one', async () => {
      prisma.savedResource.findMany.mockResolvedValue([
        { resourceId: 'res_a', resource: resourceRow({ id: 'res_a' }) },
        { resourceId: 'res_b', resource: resourceRow({ id: 'res_b' }) },
        { resourceId: 'res_c', resource: resourceRow({ id: 'res_c' }) },
      ]);

      const page = await service.findMine(USER, 2);

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe(encodeCursor('res_b'));
    });

    it('cursors on the compound key, since a resource id is not unique alone', async () => {
      await service.findMine(USER, undefined, encodeCursor(RESOURCE));

      expect(prisma.savedResource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: {
            userId_resourceId: { userId: USER, resourceId: RESOURCE },
          },
          skip: 1,
        }),
      );
    });

    it('returns a null cursor on the last page', async () => {
      prisma.savedResource.findMany.mockResolvedValue([
        { resourceId: RESOURCE, resource: resourceRow() },
      ]);

      const page = await service.findMine(USER);

      expect(page.nextCursor).toBeNull();
    });

    it('turns a cursor row that no longer exists into a 400', async () => {
      prisma.savedResource.findMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('gone', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.findMine(USER, undefined, encodeCursor('res_gone')),
      ).rejects.toThrow(BadRequestException);
    });

    it('keeps an anonymously shared resource anonymous in your own saved list', async () => {
      // Saving is not a way to un-withhold a name, and it never re-attributes the
      // resource to whoever saved it.
      prisma.savedResource.findMany.mockResolvedValue([
        {
          resourceId: RESOURCE,
          resource: resourceRow({ isAnonymous: true }),
        },
      ]);

      const page = await service.findMine(USER);

      expect(page.items[0].contributor).toBeNull();
      expect(page.items[0].contributorId).toBeNull();
      expect(page.items[0].isAnonymous).toBe(true);
    });

    it('carries the save count through, so the list can show it', async () => {
      prisma.savedResource.findMany.mockResolvedValue([
        { resourceId: RESOURCE, resource: resourceRow() },
      ]);

      const page = await service.findMine(USER);

      expect(page.items[0].savedCount).toBe(3);
    });
  });

  describe('isSaved', () => {
    it('is true when the row exists', async () => {
      prisma.savedResource.findUnique.mockResolvedValue({
        resourceId: RESOURCE,
      });

      await expect(service.isSaved(RESOURCE, USER)).resolves.toBe(true);
    });

    it('is false when it does not', async () => {
      await expect(service.isSaved(RESOURCE, USER)).resolves.toBe(false);
    });

    it('looks up the caller’s own row, on the composite key', async () => {
      await service.isSaved(RESOURCE, USER);

      expect(prisma.savedResource.findUnique).toHaveBeenCalledWith({
        where: { userId_resourceId: { userId: USER, resourceId: RESOURCE } },
        select: { resourceId: true },
      });
    });
  });

  describe('save', () => {
    it('saves any resource, not only the caller’s own', async () => {
      await service.save(RESOURCE, USER);

      expect(prisma.savedResource.createMany).toHaveBeenCalledWith({
        data: { userId: USER, resourceId: RESOURCE },
        skipDuplicates: true,
      });
    });

    it('lets a double click be a no-op rather than a conflict', async () => {
      await expect(service.save(RESOURCE, USER)).resolves.toBeDefined();
    });

    it('returns the resource with its count, so the button can render it', async () => {
      const result = await service.save(RESOURCE, USER);

      expect(result.savedCount).toBe(3);
    });

    it('404s a resource that does not exist, rather than letting the FK 500', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(service.save('res_nope', USER)).rejects.toThrow(
        NotFoundException,
      );

      expect(prisma.savedResource.createMany).not.toHaveBeenCalled();
    });

    it('writes only the saved row, because collecting is a separate act', async () => {
      await service.save(RESOURCE, USER);

      // The single write is the bookmark. Nothing about a collection membership
      // is touched, because the two are independent by decision — a saved
      // resource stays saved when you also file it somewhere.
      expect(prisma.savedResource.createMany).toHaveBeenCalledTimes(1);
      expect(
        Object.keys(
          (
            prisma.savedResource.createMany.mock.calls as unknown as [
              [{ data: Record<string, unknown> }],
            ]
          )[0][0].data,
        ),
      ).toEqual(['userId', 'resourceId']);
    });
  });

  describe('unsave', () => {
    it('removes the row', async () => {
      await service.unsave(RESOURCE, USER);

      expect(prisma.savedResource.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER, resourceId: RESOURCE },
      });
    });

    it('succeeds when it was not saved, since that is the state asked for', async () => {
      prisma.savedResource.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.unsave(RESOURCE, USER)).resolves.toBeDefined();
    });

    it('does not require the resource itself to still exist', async () => {
      // Its saved rows would have cascaded away, and the caller’s request has
      // still been honoured — so this is a 200, not a 404.
      await expect(service.unsave(RESOURCE, USER)).resolves.toBeDefined();
    });

    it('returns the resource with a refreshed count', async () => {
      prisma.resource.findUnique.mockResolvedValue(
        resourceRow({ _count: { savedResources: 2 } }),
      );

      const result = await service.unsave(RESOURCE, USER);

      expect(result.savedCount).toBe(2);
    });
  });
});
