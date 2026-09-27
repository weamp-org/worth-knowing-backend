import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { MAX_TAGS_PER_RESOURCE, TagsService } from './tags.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TagsService', () => {
  let service: TagsService;
  let prisma: {
    tag: { createMany: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagsService,
        {
          provide: PrismaService,
          useValue: {
            tag: { createMany: jest.fn(), findMany: jest.fn() },
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

  describe('search', () => {
    const tagRow = (slug: string, resourceCount: number) => ({
      id: `id_${slug}`,
      name: slug,
      slug,
      _count: { resources: resourceCount },
    });

    it('filters on name, case-insensitively', async () => {
      prisma.tag.findMany.mockResolvedValue([]);

      await service.search('machine');

      expect(prisma.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { name: { contains: 'machine', mode: 'insensitive' } },
        }),
      );
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

    it('caps the candidate set', async () => {
      prisma.tag.findMany.mockResolvedValue([]);

      await service.search('a');

      expect(prisma.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });
  });
});
