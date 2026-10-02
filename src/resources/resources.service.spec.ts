import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';

import { ResourcesService } from './resources.service';
import { encodeCursor } from '../pagination/cursor.util';
import { PrismaService } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import {
  AccessType,
  ResourceReportReason,
  ResourceType,
  UserRole,
} from '../generated/prisma/enums';
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
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    resourceReport: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
    user: { findUnique: jest.Mock };
  };

  /**
   * A partial matcher for a `data` payload.
   *
   * `expect.objectContaining` returns `any`, which trips no-unsafe-assignment once it
   * is nested inside an object literal. Narrowed once here so each assertion can stay
   * partial instead of pinning every field.
   */
  const dataContaining = (expected: Record<string, unknown>) =>
    expect.objectContaining(expected) as unknown as object;
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
              // No match by default, so the duplicate guard stays out of the way
              // of every other test in this file.
              findFirst: jest.fn().mockResolvedValue(null),
              update: jest.fn(),
              delete: jest.fn(),
            },
            resourceReport: {
              createMany: jest.fn().mockResolvedValue({ count: 1 }),
              findMany: jest.fn().mockResolvedValue([]),
              updateMany: jest.fn().mockResolvedValue({ count: 3 }),
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
      contributor: {
        id: 'user_1',
        name: 'Ada',
        imageUrl: null,
        usernameLower: 'ada',
        isProfilePrivate: false,
      },
      isAnonymous: false,
      tags: [],
      // `resourceInclude` selects it, so every row the mapper reads carries it.
      // Without it `withProfilePath` throws reading `_count.savedResources`.
      _count: { savedResources: 0 },
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

  describe('profilePath', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'res_1',
      title: 'Sapiens',
      contributorId: 'user_1',
      contributor: {
        id: 'user_1',
        name: 'Ada',
        imageUrl: null,
        usernameLower: 'ada',
        isProfilePrivate: false,
      },
      isAnonymous: false,
      tags: [],
      // `resourceInclude` selects it, so every row the mapper reads carries it.
      // Without it `withProfilePath` throws reading `_count.savedResources`.
      _count: { savedResources: 0 },
      ...over,
    });

    it('points at the profile for a public one', async () => {
      prisma.resource.findUnique.mockResolvedValue(row());

      const result = await service.findOne('res_1');

      expect(result.contributor?.profilePath).toBe('/u/ada');
    });

    // Privacy here withdraws the destination, not the name. Whether a name
    // appears is `isAnonymous`, a decision the contributor made per resource.
    it('is null for a private profile but keeps the name attached', async () => {
      prisma.resource.findUnique.mockResolvedValue(
        row({
          contributor: {
            id: 'user_1',
            name: 'Ada',
            imageUrl: null,
            usernameLower: 'ada',
            isProfilePrivate: true,
          },
        }),
      );

      const result = await service.findOne('res_1', 'stranger');

      expect(result.contributor?.profilePath).toBeNull();
      expect(result.contributor?.name).toBe('Ada');
    });

    it('is null for an account that has not claimed a username', async () => {
      prisma.resource.findUnique.mockResolvedValue(
        row({
          contributor: {
            id: 'user_1',
            name: 'Ada',
            imageUrl: null,
            usernameLower: null,
            isProfilePrivate: false,
          },
        }),
      );

      const result = await service.findOne('res_1');

      expect(result.contributor?.profilePath).toBeNull();
    });

    it('never reaches the response on an anonymous post', async () => {
      prisma.resource.findUnique.mockResolvedValue(row({ isAnonymous: true }));

      const result = await service.findOne('res_1', 'stranger');

      expect(result.contributor).toBeNull();
      // Nothing about the profile is left to correlate the post against.
      expect(JSON.stringify(result)).not.toContain('ada');
    });

    it('drops the two fields it is derived from', async () => {
      prisma.resource.findUnique.mockResolvedValue(row());

      const result = await service.findOne('res_1');

      expect(result.contributor).not.toHaveProperty('usernameLower');
      expect(result.contributor).not.toHaveProperty('isProfilePrivate');
    });

    it('applies to every row in a page', async () => {
      prisma.resource.findMany.mockResolvedValue([
        row({ id: 'a' }),
        row({ id: 'b' }),
      ]);

      const page = await service.findAll();

      expect(
        page.items.every((item) => item.contributor?.profilePath === '/u/ada'),
      ).toBe(true);
    });
  });

  describe('contributor filter', () => {
    const row = (id: string) => ({
      id,
      contributorId: 'user_1',
      contributor: null,
      isAnonymous: false,
      tags: [],
      _count: { savedResources: 0 },
    });

    it('filters by contributor username', async () => {
      prisma.resource.findMany.mockResolvedValue([row('a')]);

      await service.findAll(undefined, undefined, undefined, undefined, 'ada');

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            contributor: { usernameLower: 'ada' },
            isAnonymous: false,
          },
        }),
      );
    });

    it('combines with a tag filter rather than replacing it', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll(
        'evolution',
        undefined,
        undefined,
        undefined,
        'ada',
      );

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tags: { some: { slug: 'evolution' } },
            contributor: { usernameLower: 'ada' },
            isAnonymous: false,
          },
        }),
      );
    });

    // Listing them would disclose the existence of posts the contributor chose
    // to withhold, publish the `why` they wrote to justify an unattributed
    // contribution, and disagree with `resourcesCount`, which already excludes
    // them. A profile saying "1 contribution" above two cards is also just
    // visibly wrong.
    it('excludes anonymous contributions from a profile listing', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll(undefined, undefined, undefined, undefined, 'ada');

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ where: Record<string, unknown> }],
      ];

      expect(arg.where).toMatchObject({
        contributor: { usernameLower: 'ada' },
        isAnonymous: false,
      });
    });

    // An anonymous post is public *content*, merely unattributed. Dropping it
    // from the feed would remove something a reader was always allowed to see.
    it('still shows anonymous contributions on the unfiltered feed', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll();

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ where?: Record<string, unknown> }],
      ];

      expect(arg.where).toBeUndefined();
    });

    it('passes no where clause at all when unfiltered', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll();

      const [[arg]] = prisma.resource.findMany.mock.calls as unknown as [
        [{ where?: unknown }],
      ];

      // `where: {}` would change the plan Prisma picks; an absent key is what the
      // unfiltered feed has always sent.
      expect(arg.where).toBeUndefined();
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

  describe('duplicate links', () => {
    it('rejects the same contributor sharing a link twice', async () => {
      prisma.resource.findFirst.mockResolvedValue({ id: 'res_1' });

      await expect(service.create(createDto, 'user_1')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.create(createDto, 'user_1')).rejects.toThrow(
        /already shared this link/,
      );
      expect(prisma.resource.create).not.toHaveBeenCalled();
    });

    // The check is scoped to the contributor, so the duplicate lookup must be.
    // A global check would be the thing that throws away somebody's `why`.
    it('scopes the lookup to the contributor, not the link', async () => {
      await service.create(createDto, 'user_1');

      expect(prisma.resource.findFirst).toHaveBeenCalledWith({
        where: { url: createDto.url, contributorId: 'user_1' },
        select: { id: true },
      });
    });

    it('allows two different contributors to share the same link', async () => {
      prisma.resource.create.mockResolvedValue({ id: 'res_2' });

      await service.create(createDto, 'user_1');
      await service.create(createDto, 'user_2');

      expect(prisma.resource.create).toHaveBeenCalledTimes(2);
    });

    // Check-then-write has a window. The unique index is what actually decides,
    // so a losing racer has to come out as the same 409 rather than a 500.
    it('turns a unique-index violation into the same conflict', async () => {
      prisma.resource.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.10.0',
        }),
      );

      await expect(service.create(createDto, 'user_1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('does not swallow an unrelated database error', async () => {
      prisma.resource.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.create(createDto, 'user_1')).rejects.toThrow(
        'connection lost',
      );
    });

    it('does not check at all when the resource is only being re-saved', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'user_1',
        isAnonymous: false,
        _count: { savedResources: 0 },
      });
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });
      prisma.resource.findFirst.mockClear();

      await service.update('res_1', { title: 'New' }, 'user_1');

      expect(prisma.resource.findFirst).not.toHaveBeenCalled();
    });

    it('rejects an edit that moves a resource onto a link it already shares', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'user_1',
        isAnonymous: false,
        _count: { savedResources: 0 },
      });
      prisma.resource.findFirst.mockResolvedValue({ id: 'res_2' });

      await expect(
        service.update(
          'res_1',
          { url: 'https://example.com/sapiens' },
          'user_1',
        ),
      ).rejects.toThrow(ConflictException);
      expect(prisma.resource.update).not.toHaveBeenCalled();
    });

    it('checks the edit against the contributor, excluding the resource itself', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'user_1',
        isAnonymous: false,
        _count: { savedResources: 0 },
      });
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      await service.update(
        'res_1',
        { url: 'https://example.com/sapiens' },
        'user_1',
      );

      expect(prisma.resource.findFirst).toHaveBeenCalledWith({
        where: {
          url: 'https://example.com/sapiens',
          contributorId: 'user_1',
          id: { not: 'res_1' },
        },
        select: { id: true },
      });
    });

    it('turns a unique-index violation on edit into the same conflict', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'user_1',
        isAnonymous: false,
        _count: { savedResources: 0 },
      });
      prisma.resource.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.10.0',
        }),
      );

      await expect(
        service.update('res_1', { url: 'https://example.com/new' }, 'user_1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    // Deliberately minimal — these tests are about pagination arithmetic, not the
    // response shape. `_count` is still needed because every row read goes
    // through `toResourceResponse`.
    const row = (id: string) => ({
      id,
      createdAt: new Date(),
      _count: { savedResources: 0 },
    });

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
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        _count: { savedResources: 0 },
      });

      const result = await service.findOne('res_1');

      // `savedCount` is flattened out of `_count`, so a row that only carried an
      // id still comes back with it.
      expect(result).toEqual({ id: 'res_1', savedCount: 0 });
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
      // The ownership guard reads this row through `toResourceResponse`, so even
      // a deliberately partial fixture has to carry the selected count.
      _count: { savedResources: 0 },
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
        _count: { savedResources: 0 },
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
        _count: { savedResources: 0 },
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
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.ADMIN });
      prisma.resource.update.mockResolvedValue({ id: 'res_1' });

      // No `isAdmin` flag is threaded in any more: the guard reads the actor's
      // own role, so an admin reaches this without the controller having to know
      // anything about roles.
      await service.update('res_1', { title: 'Moderated' }, 'admin_1');

      expect(prisma.resource.update).toHaveBeenCalled();
    });

    it('refuses a non-owner who is not an admin', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('someone_else'));
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.USER });

      await expect(
        service.update('res_1', { title: 'Hijacked' }, 'user_1'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.resource.update).not.toHaveBeenCalled();
    });

    it('refuses to update a resource whose contributor was deleted', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: null,
        isAnonymous: false,
        _count: { savedResources: 0 },
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
    /** A row the caller owns, so the ownership guard passes. */
    const ownedBy = (userId: string) => ({
      id: 'res_1',
      contributorId: userId,
      isAnonymous: false,
      // The ownership guard reads this row through `toResourceResponse`, so even
      // a deliberately partial fixture has to carry the selected count.
      _count: { savedResources: 0 },
    });

    it('lets the contributor delete their own resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('user_1'));
      prisma.resource.delete.mockResolvedValue({ id: 'res_1' });

      const result = await service.remove('res_1', 'user_1');

      expect(prisma.resource.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'res_1' } }),
      );
      expect(result).toEqual({ id: 'res_1' });
    });

    // Regression: the guard read the row redacted, which nulls
    // `contributorId`, so the owner was locked out of their own anonymous post.
    it('lets the owner delete their own anonymous resource', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: 'user_1',
        isAnonymous: true,
        _count: { savedResources: 0 },
      });
      prisma.resource.delete.mockResolvedValue({ id: 'res_1' });

      await service.remove('res_1', 'user_1');

      expect(prisma.resource.delete).toHaveBeenCalled();
    });

    it('refuses a non-owner who is not an admin', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('someone_else'));
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.USER });

      await expect(service.remove('res_1', 'user_1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });

    it('lets an admin delete any resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(ownedBy('someone_else'));
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.ADMIN });
      prisma.resource.delete.mockResolvedValue({ id: 'res_1' });

      await service.remove('res_1', 'admin_1');

      expect(prisma.resource.delete).toHaveBeenCalled();
    });

    it('refuses to delete a resource whose contributor was deleted', async () => {
      prisma.resource.findUnique.mockResolvedValue({
        id: 'res_1',
        contributorId: null,
        isAnonymous: false,
        _count: { savedResources: 0 },
      });
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.USER });

      await expect(service.remove('res_1', 'user_1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException rather than deleting a missing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(service.remove('res_missing', 'user_1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });
  });

  describe('reporting', () => {
    const REPORTED = 'res_1';
    const REPORTER = 'user_2';
    const CONTRIBUTOR = 'user_1';

    beforeEach(() => {
      prisma.resource.findUnique.mockResolvedValue({
        id: REPORTED,
        contributorId: CONTRIBUTOR,
      });
    });

    it('files the report with its category and the session user', async () => {
      await service.report(REPORTED, REPORTER, {
        reason: ResourceReportReason.BROKEN_LINK,
        detail: 'It 404s now.',
      });

      expect(prisma.resourceReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: REPORTER,
          resourceId: REPORTED,
          reason: ResourceReportReason.BROKEN_LINK,
          detail: 'It 404s now.',
        },
        skipDuplicates: true,
      });
    });

    it('stores the category alone when no detail was given', async () => {
      // The category is what sorts the queue, so it is the required half. The detail
      // is optional precisely so a required wall of text cannot stop a report.
      await service.report(REPORTED, REPORTER, {
        reason: ResourceReportReason.SPAM,
      });

      expect(prisma.resourceReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: REPORTER,
          resourceId: REPORTED,
          reason: ResourceReportReason.SPAM,
        },
        skipDuplicates: true,
      });
    });

    it('trims the detail, and drops a whitespace-only one', async () => {
      await service.report(REPORTED, REPORTER, {
        reason: ResourceReportReason.SPAM,
        detail: '   ',
      });

      expect(prisma.resourceReport.createMany).toHaveBeenCalledWith({
        data: {
          reporterId: REPORTER,
          resourceId: REPORTED,
          reason: ResourceReportReason.SPAM,
        },
        skipDuplicates: true,
      });
    });

    it('skips duplicates, so a double-click is not punished and cannot pad the count', async () => {
      await service.report(REPORTED, REPORTER, {
        reason: ResourceReportReason.SPAM,
      });

      expect(prisma.resourceReport.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('refuses a report on your own contribution', async () => {
      await expect(
        service.report(REPORTED, CONTRIBUTOR, {
          reason: ResourceReportReason.SPAM,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.resourceReport.createMany).not.toHaveBeenCalled();
    });

    it('404s for a resource that is not there', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(
        service.report('res_missing', REPORTER, {
          reason: ResourceReportReason.SPAM,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets anybody signed in report somebody else’s contribution', async () => {
      // No role check at all: reporting is not a privileged act, which is the point.
      await service.report(REPORTED, REPORTER, {
        reason: ResourceReportReason.SPAM,
      });

      expect(prisma.resourceReport.createMany).toHaveBeenCalled();
    });
  });

  describe('listResourceReports', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      reporterId: 'user_2',
      resourceId: 'res_1',
      reason: 'This link just installed something.',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      resource: {
        id: 'res_1',
        title: 'Sapiens',
        url: 'https://example.com/sapiens',
        type: ResourceType.BOOK,
        accessType: AccessType.PAID,
        why: 'The clearest account I have read.',
        isAnonymous: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        contributorId: 'user_1',
        contributor: {
          id: 'user_1',
          name: 'Ada',
          imageUrl: null,
          username: 'ada',
          usernameLower: 'ada',
          isProfilePrivate: false,
        },
        tags: [],
        _count: { savedResources: 0, comments: 0, reports: 4 },
      },
      ...over,
    });

    beforeEach(() => {
      prisma.resourceReport.findMany.mockResolvedValue([row()]);
    });

    it('orders by when it was flagged, not when it was shared', async () => {
      await service.listResourceReports();

      // Paged over the report, for the same reason the saved list is: a two-year-old
      // contribution reported yesterday is the newest thing a moderator has to see.
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
      const page = await service.listResourceReports();

      expect(page.items[0]).not.toHaveProperty('reporterId');
      expect(page.items[0]).not.toHaveProperty('reporter');
      expect(page.items[0].id).toBe(`res_1:user_2`);
    });

    it('carries the report count so the queue is triageable at a glance', async () => {
      const page = await service.listResourceReports();

      expect(page.items[0].reportCount).toBe(4);
    });

    it('still redacts an anonymously shared contribution', async () => {
      // `toResourceReportResponse` routes the resource through the ordinary public
      // read, so a moderator does not get to un-withhold a name. They do not need it
      // to decide a link is spam, and this is the person most likely to be tempted.
      prisma.resourceReport.findMany.mockResolvedValue([
        row({ resource: { ...row().resource, isAnonymous: true } }),
      ]);

      const page = await service.listResourceReports();

      expect(page.items[0].resource.contributor).toBeNull();
      expect(page.items[0].resource.contributorId).toBeNull();
    });

    it('passes the category through and flattens an absent detail', async () => {
      // The category is required and stored; only the detail is optional, and it is
      // flattened so a client renders the text without a fallback that reads as a bug
      // rather than as an absent detail.
      prisma.resourceReport.findMany.mockResolvedValue([
        row({ reason: ResourceReportReason.BROKEN_LINK, detail: null }),
      ]);

      const page = await service.listResourceReports();

      expect(page.items[0].reason).toBe('BROKEN_LINK');
      expect(page.items[0].detail).toBe('');
    });

    it('asks for one row over the page, so hasMore needs no COUNT(*)', async () => {
      await service.listResourceReports(5);

      expect(prisma.resourceReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 6 }),
      );
    });

    it('trims the extra row and cursors on the last kept one', async () => {
      prisma.resourceReport.findMany.mockResolvedValue([
        row({ resourceId: 'res_a' }),
        row({ resourceId: 'res_b' }),
        row({ resourceId: 'res_c' }),
      ]);

      const page = await service.listResourceReports(2);

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe(encodeCursor('res_b:user_2'));
    });

    it('cursors on the composite key, since one person reports many resources', async () => {
      await service.listResourceReports(
        undefined,
        encodeCursor('res_1:user_2'),
      );

      expect(prisma.resourceReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: {
            reporterId_resourceId: {
              reporterId: 'user_2',
              resourceId: 'res_1',
            },
          },
          skip: 1,
        }),
      );
    });

    it('rejects a cursor that is not a target:reporter pair', async () => {
      await expect(
        service.listResourceReports(undefined, encodeCursor('res_1')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400s a cursor naming a row that is gone, since a report can be deleted', async () => {
      prisma.resourceReport.findMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('gone', {
          code: 'P2025',
          clientVersion: '7.0.0',
        }),
      );

      await expect(
        service.listResourceReports(undefined, encodeCursor('res_gone:user_2')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('dismiss', () => {
    it('marks every report on the contribution at once', async () => {
      await service.dismiss('res_1');

      // A resource five people reported is five rows; dismissing one would leave four,
      // which is to say the queue could never be worked through.
      expect(prisma.resourceReport.updateMany).toHaveBeenCalledWith({
        where: { resourceId: 'res_1', dismissedAt: null },
        data: dataContaining({ dismissedAt: expect.any(Date) }),
      });
    });

    it('touches only undisismissed rows, so a second dismissal is a no-op', async () => {
      await service.dismiss('res_1');

      // Idempotency as a query condition rather than as an error: two moderators
      // reaching for the same row at once is ordinary, and neither should see a
      // failure for it.
      expect(prisma.resourceReport.updateMany).toHaveBeenCalledWith(
        dataContaining({ where: { resourceId: 'res_1', dismissedAt: null } }),
      );
    });

    it('does not remove the contribution', async () => {
      await service.dismiss('res_1');

      // Dismissal is "seen, keeping it". Removing is a separate action with its own
      // route — and conflating them would make removal the answer to every report,
      // including a BROKEN_LINK on a `why` worth keeping and fixing.
      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });

    it('succeeds when there is nothing to dismiss', async () => {
      prisma.resourceReport.updateMany.mockResolvedValue({ count: 0 });

      // Already dismissed, or never reported. "It is not in the queue" is exactly the
      // state the caller asked for, so there is nothing to report.
      await expect(service.dismiss('res_unknown')).resolves.toBeUndefined();
    });
  });

  describe('undismiss', () => {
    it('reopens every dismissed report on the contribution', async () => {
      await service.undismiss('res_1');

      // The safety net that lets the client skip a confirmation dialog.
      expect(prisma.resourceReport.updateMany).toHaveBeenCalledWith({
        where: { resourceId: 'res_1', dismissedAt: { not: null } },
        data: { dismissedAt: null },
      });
    });

    it('touches only rows a dismissal closed', async () => {
      await service.undismiss('res_1');

      // `not: null` rather than every row: a report filed *after* the dismissal is
      // already open and already queued, so reopening must leave it where it is rather
      // than disturbing a report nobody resolved.
      expect(prisma.resourceReport.updateMany).toHaveBeenCalledWith(
        dataContaining({
          where: { resourceId: 'res_1', dismissedAt: { not: null } },
        }),
      );
    });

    it('does not remove the contribution on the way through', async () => {
      await service.undismiss('res_1');

      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });

    it('succeeds when nothing was dismissed', async () => {
      prisma.resourceReport.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.undismiss('res_1')).resolves.toBeUndefined();
    });
  });
});
