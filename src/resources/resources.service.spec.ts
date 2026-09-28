import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';

import { ResourcesService } from './resources.service';
import { encodeCursor } from './cursor.util';
import { PrismaService } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import { AccessType, ResourceType } from '../generated/prisma/enums';
import { CreateResourceDto } from './dtos/create-resource.dto';

const createDto = {
  title: 'Sapiens',
  url: 'https://example.com/sapiens',
  type: ResourceType.BOOK,
  accessType: AccessType.PAID,
  why: 'The clearest explanation of human institutions I have read.',
};

describe('ResourcesService', () => {
  let service: ResourcesService;
  let prisma: {
    resource: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    user: { findUnique: jest.Mock };
  };
  let tags: { normalizeTags: jest.Mock; ensureTags: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourcesService,
        {
          provide: PrismaService,
          useValue: {
            resource: {
              create: jest.fn(),
              findMany: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            user: { findUnique: jest.fn().mockResolvedValue(null) },
          },
        },
        {
          provide: TagsService,
          useValue: {
            normalizeTags: jest.fn().mockReturnValue([]),
            ensureTags: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(ResourcesService);
    prisma = module.get(PrismaService);
    tags = module.get(TagsService);
  });

  // Typed readers for the write payloads. `expect.objectContaining` returns
  // `any`, which trips no-unsafe-assignment once nested in an object literal.
  const createData = (): Record<string, unknown> => {
    const [[arg]] = prisma.resource.create.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    return arg.data;
  };

  const updateData = (): Record<string, unknown> => {
    const [[arg]] = prisma.resource.update.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    return arg.data;
  };

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('anonymity', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'res_1',
      title: 'Sapiens',
      contributorId: 'user_1',
      contributor: { id: 'user_1', name: 'Ada', imageUrl: null },
      isAnonymous: false,
      tags: [],
      ...over,
    });

    describe('create', () => {
      it('defaults to public when the contributor prefers public', async () => {
        prisma.user.findUnique.mockResolvedValue({ anonymousByDefault: false });
        prisma.resource.create.mockResolvedValue(createDto);

        await service.create(createDto, 'user_1');

        expect(createData().isAnonymous).toBe(false);
      });

      it("applies the contributor's standing preference when omitted", async () => {
        prisma.user.findUnique.mockResolvedValue({ anonymousByDefault: true });
        prisma.resource.create.mockResolvedValue(createDto);

        await service.create(createDto, 'user_1');

        expect(createData().isAnonymous).toBe(true);
      });

      it('lets the request override the standing preference', async () => {
        prisma.user.findUnique.mockResolvedValue({ anonymousByDefault: true });
        prisma.resource.create.mockResolvedValue(createDto);

        await service.create({ ...createDto, isAnonymous: false }, 'user_1');

        expect(createData().isAnonymous).toBe(false);
        // The preference is not even consulted when the request was explicit.
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
      });

      it('shares publicly when the contributor row is missing', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.resource.create.mockResolvedValue(createDto);

        await service.create(createDto, 'ghost');

        expect(createData().isAnonymous).toBe(false);
      });
    });

    describe('read', () => {
      it('withholds the contributor from an anonymous resource', async () => {
        prisma.resource.findUnique.mockResolvedValue(
          row({ isAnonymous: true }),
        );

        const result = await service.findOne('res_1');

        expect(result.contributor).toBeNull();
        expect(result.contributorId).toBeNull();
      });

      // The whole point of hiding the id too: it is the same on that person's
      // public contributions, so leaving it would let anyone correlate the two.
      it('leaves nothing on an anonymous resource to correlate', async () => {
        prisma.resource.findUnique.mockResolvedValue(
          row({ isAnonymous: true }),
        );

        const result = await service.findOne('res_1');

        expect(JSON.stringify(result)).not.toContain('user_1');
        expect(JSON.stringify(result)).not.toContain('Ada');
      });

      it('shows the contributor to the owner despite anonymity', async () => {
        prisma.resource.findUnique.mockResolvedValue(
          row({ isAnonymous: true }),
        );

        const result = await service.findOne('res_1', 'user_1');

        expect(result.contributorId).toBe('user_1');
        expect(result.contributor?.name).toBe('Ada');
      });

      it('still withholds from a signed-in stranger', async () => {
        prisma.resource.findUnique.mockResolvedValue(
          row({ isAnonymous: true }),
        );

        const result = await service.findOne('res_1', 'someone_else');

        expect(result.contributorId).toBeNull();
      });

      it('keeps isAnonymous on the response so the UI can word it', async () => {
        prisma.resource.findUnique.mockResolvedValue(
          row({ isAnonymous: true }),
        );

        const result = await service.findOne('res_1');

        expect(result.isAnonymous).toBe(true);
      });

      it('leaves a public resource untouched', async () => {
        prisma.resource.findUnique.mockResolvedValue(row());

        const result = await service.findOne('res_1', 'stranger');

        expect(result.contributorId).toBe('user_1');
        expect(result.contributor?.name).toBe('Ada');
      });

      it('redacts every row in a page, not just the first', async () => {
        prisma.resource.findMany.mockResolvedValue([
          row({ id: 'a', isAnonymous: true }),
          row({ id: 'b', isAnonymous: true }),
        ]);

        const page = await service.findAll();

        expect(page.items.every((item) => item.contributorId === null)).toBe(
          true,
        );
      });
    });

    describe('isMine', () => {
      it('is true for the contributor', async () => {
        prisma.resource.findUnique.mockResolvedValue({
          contributorId: 'user_1',
        });

        await expect(service.isMine('res_1', 'user_1')).resolves.toBe(true);
      });

      it('is false for anyone else', async () => {
        prisma.resource.findUnique.mockResolvedValue({
          contributorId: 'user_1',
        });

        await expect(service.isMine('res_1', 'stranger')).resolves.toBe(false);
      });

      it('is false for a resource whose contributor was deleted', async () => {
        prisma.resource.findUnique.mockResolvedValue({ contributorId: null });

        await expect(service.isMine('res_1', 'user_1')).resolves.toBe(false);
      });

      it('is false for a resource that does not exist', async () => {
        prisma.resource.findUnique.mockResolvedValue(null);

        await expect(service.isMine('missing', 'user_1')).resolves.toBe(false);
      });
    });
  });

  describe('create', () => {
    it('attributes the resource to the given contributor', async () => {
      prisma.resource.create.mockResolvedValue(createDto);

      await service.create(createDto, 'clerk_123');

      expect(createData().contributorId).toBe('clerk_123');
    });

    it('never accepts a contributorId from the DTO', async () => {
      prisma.resource.create.mockResolvedValue(createDto);

      await service.create(
        {
          ...createDto,
          contributorId: 'clerk_someone_else',
        } as CreateResourceDto,
        'clerk_123',
      );

      expect(createData().contributorId).toBe('clerk_123');
    });

    it('does not put the raw tags array into the create payload', async () => {
      prisma.resource.create.mockResolvedValue(createDto);

      await service.create({ ...createDto, tags: ['Evolution'] }, 'clerk_1');

      expect(createData().tags).toEqual({ connect: [] });
    });

    it('creates then connects normalized tags', async () => {
      const tagRows = [
        { name: 'Evolution', slug: 'evolution' },
        { name: 'C++', slug: 'c++' },
      ];
      tags.normalizeTags.mockReturnValue(tagRows);
      prisma.resource.create.mockResolvedValue(createDto);

      await service.create(
        { ...createDto, tags: ['Evolution', 'C++'] },
        'clerk_1',
      );

      expect(tags.normalizeTags).toHaveBeenCalledWith(['Evolution', 'C++']);
      expect(tags.ensureTags).toHaveBeenCalledWith(tagRows);
      expect(createData().tags).toEqual({
        connect: [{ slug: 'evolution' }, { slug: 'c++' }],
      });
    });
  });

  describe('findAll', () => {
    const row = (id: string) => ({ id, createdAt: new Date() });

    it('orders newest first with id as a tiebreaker', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: undefined,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('filters by tag slug when given one', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll('machine-learning');

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tags: { some: { slug: 'machine-learning' } } },
        }),
      );
    });

    it('defaults to 20 and fetches one extra row to detect more', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 21 }),
      );
    });

    it('honours an explicit limit', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll(undefined, 5);

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 6 }),
      );
    });

    it('returns a nextCursor when a further page exists', async () => {
      prisma.resource.findMany.mockResolvedValue([
        row('a'),
        row('b'),
        row('c'),
      ]);

      const result = await service.findAll(undefined, 2);

      expect(result.items.map((r) => r.id)).toEqual(['a', 'b']);
      expect(result.nextCursor).toBe(encodeCursor('b'));
    });

    it('returns a null cursor on the last page', async () => {
      prisma.resource.findMany.mockResolvedValue([row('a'), row('b')]);

      const result = await service.findAll(undefined, 2);

      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it('handles an empty page without inventing a cursor', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result).toEqual({ items: [], nextCursor: null });
    });

    it('passes a decoded cursor to prisma and skips the cursor row', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll(undefined, 20, encodeCursor('ckq8f2'));

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { id: 'ckq8f2' }, skip: 1 }),
      );
    });

    it('omits the cursor clause on the first page', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll();

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [Record<string, unknown>],
      ];
      expect(arg).not.toHaveProperty('cursor');
      expect(arg).not.toHaveProperty('skip');
    });

    it('rejects a malformed cursor before hitting the database', async () => {
      const cursor = Buffer.from("' OR 1=1 --", 'utf8').toString('base64url');

      await expect(service.findAll(undefined, 20, cursor)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.resource.findMany).not.toHaveBeenCalled();
    });

    it('turns a cursor for a deleted row into a 400, not a 500', async () => {
      prisma.resource.findMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('cursor not found', {
          code: 'P2025',
          clientVersion: '7.10.0',
        }),
      );

      await expect(
        service.findAll(undefined, 20, encodeCursor('ckq8f2')),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not swallow an unrelated database error', async () => {
      const boom = new Prisma.PrismaClientKnownRequestError('deadlock', {
        code: 'P2034',
        clientVersion: '7.10.0',
      });
      prisma.resource.findMany.mockRejectedValue(boom);

      await expect(service.findAll()).rejects.toBe(boom);
    });
  });

  describe('findOne', () => {
    it('returns the resource when found', async () => {
      prisma.resource.findUnique.mockResolvedValue({ id: 'res_1' });

      const result = await service.findOne('res_1');

      expect(result).toEqual({ id: 'res_1' });
    });

    it('throws NotFoundException when missing', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(service.findOne('res_missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    /** A row the caller owns, so the ownership guard passes. */
    const ownedBy = (userId: string) => ({
      id: 'res_1',
      contributorId: userId,
      isAnonymous: false,
    });

    it('updates an existing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('user_1'));
      prisma.resource.update.mockResolvedValue({ id: 'res_1', title: 'New' });

      const result = await service.update('res_1', { title: 'New' }, 'user_1');

      expect(prisma.resource.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'res_1' },
          data: { title: 'New' },
        }),
      );
      expect(result).toEqual({ id: 'res_1', title: 'New' });
    });

    // Without this, any signed-in user could flip `isAnonymous` on somebody
    // else's contribution and undo the control anonymity exists to provide.
    it('lets the owner edit their own anonymous resource', async () => {
      // Regression: the guard read the row redacted, which nulls
      // `contributorId`, so the owner was locked out of their own post. It only
      // passes because `update` reads it *as the actor*.
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'user_1',
        isAnonymous: true,
      });
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      await service.update('res_1', { isAnonymous: false }, 'user_1');

      expect(prisma.resource.update).toHaveBeenCalled();
    });

    it('still refuses an anonymous resource belonging to someone else', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'someone_else',
        isAnonymous: true,
      });

      await expect(
        service.update('res_1', { isAnonymous: false }, 'user_1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses to update a resource the caller did not contribute', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('someone_else'));

      await expect(
        service.update('res_1', { title: 'Hijacked' }, 'user_1'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.resource.update).not.toHaveBeenCalled();
    });

    it('lets an admin update any resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('someone_else'));
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      await service.update('res_1', { title: 'Moderated' }, 'admin_1', true);

      expect(prisma.resource.update).toHaveBeenCalled();
    });

    it('refuses to update a resource whose contributor was deleted', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: null,
        isAnonymous: false,
      });

      await expect(
        service.update('res_1', { title: 'New' }, 'user_1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('replaces the whole tag set when tags are supplied', async () => {
      tags.normalizeTags.mockReturnValue([{ name: 'AI', slug: 'ai' }]);
      prisma.resource.findUnique.mockResolvedValue(ownedBy('user_1'));
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      await service.update('res_1', { tags: ['AI'] }, 'user_1');

      expect(updateData().tags).toEqual({ set: [{ slug: 'ai' }] });
    });

    it('leaves tags untouched when the update omits them', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('user_1'));
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      await service.update('res_1', { title: 'New' }, 'user_1');

      expect(updateData()).not.toHaveProperty('tags');
      expect(tags.normalizeTags).not.toHaveBeenCalled();
    });

    it('leaves isAnonymous untouched when the update omits it', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('user_1'));
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      await service.update('res_1', { title: 'New' }, 'user_1');

      expect(updateData().isAnonymous).toBeUndefined();
    });

    it('drops an explicit null isAnonymous rather than writing one', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('user_1'));
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      await service.update(
        'res_1',
        { isAnonymous: null as unknown as boolean },
        'user_1',
      );

      expect(updateData()).not.toHaveProperty('isAnonymous');
    });

    it('clears every tag when an empty array is supplied', async () => {
      tags.normalizeTags.mockReturnValue([]);
      prisma.resource.findUnique.mockResolvedValue(ownedBy('user_1'));
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      await service.update('res_1', { tags: [] }, 'user_1');

      expect(updateData().tags).toEqual({ set: [] });
    });

    it('throws NotFoundException rather than updating a missing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(
        service.update('res_missing', { title: 'New' }, 'user_1'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.resource.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes an existing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue({ id: 'res_1' });
      prisma.resource.delete.mockResolvedValue({ id: 'res_1' });

      const result = await service.remove('res_1');

      expect(prisma.resource.delete).toHaveBeenCalledWith({
        where: { id: 'res_1' },
      });
      expect(result).toEqual({ id: 'res_1' });
    });

    it('throws NotFoundException rather than deleting a missing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(service.remove('res_missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });
  });
});
