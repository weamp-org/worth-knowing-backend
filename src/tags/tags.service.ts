import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  TAG_SLUG_MAX_LENGTH,
  TAG_SLUG_MIN_LENGTH,
  isValidTagSlug,
  slugifyTag,
} from './slugify.util';

/** A tag as supplied by a contributor, before it is known to exist. */
export interface TagInput {
  name: string;
  slug: string;
}

/** How many tags a single resource may carry. */
export const MAX_TAGS_PER_RESOURCE = 5;

/** Upper bound on rows returned by {@link TagsService.search}. */
const SEARCH_RESULT_LIMIT = 20;

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Turns contributor-supplied tag names into `{ name, slug }` pairs.
   *
   * Rejects names that cannot form a usable slug, and collapses names that
   * normalize to the same slug so `"Machine Learning"` and `"machine-learning"`
   * cannot both land on one resource. The first spelling encountered wins as
   * the display name.
   *
   * @throws BadRequestException when a name is unnormalizable or out of bounds
   */
  normalizeTags(names: string[] | undefined): TagInput[] {
    if (!names?.length) return [];

    if (names.length > MAX_TAGS_PER_RESOURCE) {
      throw new BadRequestException(
        `A resource may have at most ${MAX_TAGS_PER_RESOURCE} tags`,
      );
    }

    const bySlug = new Map<string, TagInput>();

    for (const name of names) {
      const slug = slugifyTag(name);

      if (!isValidTagSlug(slug)) {
        throw new BadRequestException(
          `"${name}" is not a usable tag. Use ${TAG_SLUG_MIN_LENGTH}-${TAG_SLUG_MAX_LENGTH} letters, digits, or the characters . + # -`,
        );
      }

      if (!bySlug.has(slug)) {
        bySlug.set(slug, { name: name.trim(), slug });
      }
    }

    return [...bySlug.values()];
  }

  /**
   * Creates any tags that do not exist yet.
   *
   * Tags are created implicitly on resource write rather than through a
   * dedicated endpoint, so a tag can never exist without being attached to
   * something. `skipDuplicates` keeps this safe against concurrent writes.
   */
  async ensureTags(tags: TagInput[]): Promise<void> {
    if (!tags.length) return;

    await this.prisma.tag.createMany({ data: tags, skipDuplicates: true });
  }

  /**
   * Backs the contributor-facing typeahead.
   *
   * An empty `query` returns the most-used tags, so browsing the whole
   * vocabulary needs no separate route. Results are ordered by usage count in
   * memory rather than in SQL: a relation `_count` orderBy is not something to
   * rely on across Prisma versions, and the candidate set is capped anyway.
   */
  async search(query?: string) {
    const trimmed = query?.trim();

    const tags = await this.prisma.tag.findMany({
      where: trimmed
        ? { name: { contains: trimmed, mode: 'insensitive' } }
        : undefined,
      include: { _count: { select: { resources: true } } },
      orderBy: { createdAt: 'asc' },
      take: SEARCH_RESULT_LIMIT,
    });

    return tags
      .map(({ id, name, slug, _count }) => ({
        id,
        name,
        slug,
        resourceCount: _count.resources,
      }))
      .sort((a, b) => b.resourceCount - a.resourceCount);
  }
}
