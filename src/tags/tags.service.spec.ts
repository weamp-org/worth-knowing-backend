import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { MAX_TAGS_PER_RESOURCE, TagsService } from './tags.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TagsService', () => {
  let service: TagsService;
  let prisma: {
    tag: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagsService,
        {
          provide: PrismaService,
          useValue: {
            tag: {
              createMany: jest.fn(),
              findMany: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get(TagsService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('normalizeTags', () => {
    it('returns an empty list for undefined', () => {
      expect(service.normalizeTags(undefined)).toEqual([]);
    });

    it('returns an empty list for an empty array', () => {
      expect(service.normalizeTags([])).toEqual([]);
    });

    it('normalizes a name into a display name and a slug', () => {
      expect(service.normalizeTags(['Machine Learning'])).toEqual([
        { name: 'Machine Learning', slug: 'machine-learning' },
      ]);
    });

    it('trims the stored display name', () => {
      expect(service.normalizeTags(['  evolution  '])).toEqual([
        { name: 'evolution', slug: 'evolution' },
      ]);
    });

    it('collapses spellings that share a slug, keeping the first', () => {
      expect(
        service.normalizeTags([
          'Machine Learning',
          'machine-learning',
          'MACHINE LEARNING',
        ]),
      ).toEqual([{ name: 'Machine Learning', slug: 'machine-learning' }]);
    });

    it('preserves dots, plus signs and hashes', () => {
      expect(service.normalizeTags(['node.js', 'C++', 'C#'])).toEqual([
        { name: 'node.js', slug: 'node.js' },
        { name: 'C++', slug: 'c++' },
        { name: 'C#', slug: 'c#' },
      ]);
    });

    it.each(['!!!', '   ', '', 'a', 'a'.repeat(41)])(
      'rejects %j as unusable',
      (name) => {
        expect(() => service.normalizeTags([name])).toThrow(
          BadRequestException,
        );
      },
    );

    // Regression: the allowlist used to be ASCII-only, so combining marks were
    // swallowed and "Café" silently became "caf" with no error at all.
    it('keeps accented tags intact rather than mangling them', () => {
      expect(service.normalizeTags(['Café', 'naïve'])).toEqual([
        { name: 'Café', slug: 'cafe' },
        { name: 'naïve', slug: 'naive' },
      ]);
    });

    it('blames the character set for ordinary punctuation', () => {
      expect(() => service.normalizeTags(['!!!'])).toThrow(
        /2-40 Latin letters/,
      );
    });

    it('explains an unsupported script rather than calling it malformed', () => {
      expect(() => service.normalizeTags(['日本語'])).toThrow(
        /script that cannot be turned into a tag URL/i,
      );
    });

    it('does not blame the character set for an unsupported script', () => {
      let message = '';
      try {
        service.normalizeTags(['日本語']);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).not.toMatch(/2-40 Latin letters/);
    });

    it(`rejects more than ${MAX_TAGS_PER_RESOURCE} tags`, () => {
      const tooMany = Array.from(
        { length: MAX_TAGS_PER_RESOURCE + 1 },
        (_, i) => `tag-${i}`,
      );

      expect(() => service.normalizeTags(tooMany)).toThrow(BadRequestException);
    });

    it('accepts exactly the maximum', () => {
      const atLimit = Array.from(
        { length: MAX_TAGS_PER_RESOURCE },
        (_, i) => `tag-${i}`,
      );

      expect(service.normalizeTags(atLimit)).toHaveLength(
        MAX_TAGS_PER_RESOURCE,
      );
    });
  });

  describe('ensureTags', () => {
    it('skips the write entirely when there is nothing to create', async () => {
      await service.ensureTags([]);

      expect(prisma.tag.createMany).not.toHaveBeenCalled();
    });

    it('creates missing tags without failing on duplicates', async () => {
      const tags = [{ name: 'Evolution', slug: 'evolution' }];

      await service.ensureTags(tags);

      expect(prisma.tag.createMany).toHaveBeenCalledWith({
        data: tags,
        skipDuplicates: true,
      });
    });
  });

  describe('updateName', () => {
    it('renames the display form and leaves the slug alone', async () => {
      prisma.tag.update.mockResolvedValue({
        id: 'tag_1',
        name: 'Machine Learning',
        slug: 'machine-learning',
        _count: { resources: 3 },
      });

      const result = await service.updateName('tag_1', 'Machine Learning');

      expect(prisma.tag.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tag_1' },
          // The slug is the tag's identity and appears in feed URLs, so it is
          // not part of the write. A test that let it through would make every
          // existing `/?tag=` link 404.
          data: { name: 'Machine Learning' },
        }),
      );
      expect(result).toEqual({
        id: 'tag_1',
        name: 'Machine Learning',
        slug: 'machine-learning',
        resourceCount: 3,
      });
    });

    // An admin must not be able to install a name the contributor path would
    // have rejected.
    it('rejects a name that could not be a tag name', async () => {
      await expect(service.updateName('tag_1', 'a')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.tag.update).not.toHaveBeenCalled();
    });

    it('rejects an unsupported script', async () => {
      await expect(service.updateName('tag_1', '日本語')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.tag.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes a tag nothing is attached to', async () => {
      prisma.tag.findUnique.mockResolvedValue({
        id: 'tag_1',
        name: 'New',
        slug: 'new',
        _count: { resources: 0 },
      });
      prisma.tag.delete.mockResolvedValue({
        id: 'tag_1',
        name: 'New',
        slug: 'new',
        _count: { resources: 0 },
      });

      const result = await service.remove('tag_1');

      expect(prisma.tag.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tag_1' } }),
      );
      expect(result.resourceCount).toBe(0);
    });

    // The reason this route is not a plain cascade: one delete would strip the
    // tag from every resource carrying it, including other people's
    // contributions, with no way back. Same damage as the `DELETE /users/:id`
    // route that is deliberately not built.
    it('refuses while the tag is still attached, and says how to detach it', async () => {
      prisma.tag.findUnique.mockResolvedValue({
        id: 'tag_1',
        name: 'AI',
        slug: 'ai',
        _count: { resources: 12 },
      });

      await expect(service.remove('tag_1')).rejects.toThrow(ConflictException);
      await expect(service.remove('tag_1')).rejects.toThrow(
        /still on 12 resource/,
      );
      expect(prisma.tag.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException rather than deleting a missing tag', async () => {
      prisma.tag.findUnique.mockResolvedValue(null);

      await expect(service.remove('tag_missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.tag.delete).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    const tagRow = (slug: string, resourceCount: number) => ({
      id: `id_${slug}`,
      name: slug,
      slug,
      _count: { resources: resourceCount },
    });

    it('matches on name and slug, so a URL form finds the display form', async () => {
      prisma.tag.findMany.mockResolvedValue([]);

      await service.search('machine-learning');

      expect(prisma.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { name: { contains: 'machine-learning', mode: 'insensitive' } },
              { slug: { contains: 'machine-learning' } },
            ],
          },
        }),
      );
    });

    it('lowercases the query for the slug match, since slugs are stored folded', async () => {
      prisma.tag.findMany.mockResolvedValue([]);

      await service.search('C++');

      // Read the captured argument rather than nesting `expect` matchers, which
      // return `any` and trip the unsafe-assignment rule.
      const [args] = prisma.tag.findMany.mock.calls[0] as [
        { where: { OR: unknown[] } },
      ];

      expect(args.where.OR).toContainEqual({ slug: { contains: 'c++' } });
    });

    it('does not filter when the query is blank', async () => {
      prisma.tag.findMany.mockResolvedValue([]);

      await service.search('   ');

      expect(prisma.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('does not filter when there is no query', async () => {
      prisma.tag.findMany.mockResolvedValue([]);

      await service.search();

      expect(prisma.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('orders results by usage, most used first', async () => {
      prisma.tag.findMany.mockResolvedValue([
        tagRow('rare', 1),
        tagRow('popular', 40),
        tagRow('middling', 7),
      ]);

      const results = await service.search();

      expect(results.map((t) => t.slug)).toEqual([
        'popular',
        'middling',
        'rare',
      ]);
    });

    it('flattens the count into a plain resourceCount field', async () => {
      prisma.tag.findMany.mockResolvedValue([tagRow('evolution', 3)]);

      const [result] = await service.search('evo');

      expect(result).toEqual({
        id: 'id_evolution',
        name: 'evolution',
        slug: 'evolution',
        resourceCount: 3,
      });
    });

    // Regression: the limit used to be a SQL `take` ordered by `createdAt`,
    // applied before the usage sort. With more matches than the limit, the
    // most-used tags could be dropped before they were ever ranked.
    it('caps after ranking by usage, not before', async () => {
      const many = Array.from({ length: 40 }, (_, i) =>
        tagRow(`tag-${i.toString().padStart(2, '0')}`, i),
      );
      prisma.tag.findMany.mockResolvedValue(many);

      const results = await service.search('tag');

      // No SQL-level cap, or the wrong rows would be gone before ranking.
      const [args] = prisma.tag.findMany.mock.calls[0] as [{ take?: number }];

      expect(args.take).toBeUndefined();
      expect(results).toHaveLength(20);
    });

    it('keeps the most-used matches when the candidate set is capped', async () => {
      // Stands in for 25 matches where the heaviest were created last, which
      // is exactly what a `take` ordered by `createdAt` would have discarded.
      const many = Array.from({ length: 25 }, (_, i) =>
        tagRow(`tag-${i.toString().padStart(2, '0')}`, i),
      );
      prisma.tag.findMany.mockResolvedValue(many);

      const results = await service.search('tag');

      expect(results.map((t) => t.slug)).toContain('tag-24');
      expect(results[0]).toMatchObject({ slug: 'tag-24', resourceCount: 24 });
    });
  });
});
