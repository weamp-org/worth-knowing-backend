import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  TAG_SLUG_MAX_LENGTH,
  TAG_SLUG_MIN_LENGTH,
  isUnsupportedScript,
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

/**
 * Why a tag name was rejected.
 *
 * Scripts with no Latin decomposition get their own message, because telling
 * someone that `日本語` is not "2-40 letters" when it plainly is would be
 * nonsense. Accent folding is handled, so `café` is fine.
 */
function unusableTagMessage(name: string): string {
  if (isUnsupportedScript(name)) {
    return `"${name}" uses a script that cannot be turned into a tag URL yet. Try a Latin-script alternative.`;
  }

  return `"${name}" is not a usable tag. Use ${TAG_SLUG_MIN_LENGTH}-${TAG_SLUG_MAX_LENGTH} Latin letters, digits, or the characters . + # -`;
}

type TagWithCount = {
  id: string;
  name: string;
  slug: string;
  _count: { resources: number };
};

/**
 * One tag, in the same shape every tag route answers with.
 *
 * The relation count is flattened to a plain `resourceCount` so a client can
 * drop a single tag straight into a list from `search` without reshaping it.
 */
function toSearchResult({ id, name, slug, _count }: TagWithCount) {
  return { id, name, slug, resourceCount: _count.resources };
}

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
        throw new BadRequestException(unusableTagMessage(name));
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
   * Renames a tag's display form.
   *
   * The `slug` is deliberately not updatable. It is the tag's identity and it
   * appears in feed URLs as `/?tag=<slug>`, which other people link to. Renaming
   * it would break every existing link, and there is no slug history to redirect
   * from — a tag only knows the one name it was created under.
   *
   * So a display rename is always safe, and a slug change never is. Someone who
   * needs a different identity needs a different tag: detach this one from the
   * resources it is wrongly on, delete it, and add the correct one.
   *
   * The new name is normalized and re-validated by the same rules a
   * contributor's tag goes through, so an admin cannot install a name that
   * {@link normalizeTags} would have rejected.
   */
  async updateName(id: string, name: string) {
    const [normalized] = this.normalizeTags([name]);

    if (!normalized) {
      throw new BadRequestException('A tag needs a name');
    }

    return (
      this.prisma.tag
        .update({
          where: { id },
          data: { name: normalized.name },
          include: { _count: { select: { resources: true } } },
        })
        // Flattened to the same shape `search` returns, so a client can drop the
        // response straight back into a list without reshaping it.
        .then(toSearchResult)
    );
  }

  /**
   * Deletes a tag, but only while nothing is attached to it.
   *
   * An attached delete would cascade the detach across every resource carrying
   * the tag, including resources other people contributed — one call silently
   * rewriting N contributions, un-undoable. That is the same shape of damage as
   * the `DELETE /users/:id` route that was deliberately never built, so this
   * refuses instead.
   *
   * The supported route is to detach the tag from the offending resources with
   * `PATCH /resources/:id` — one resource, one attributable change — and delete
   * the tag once it is empty. This is also the only way the count can reach zero:
   * tags are created implicitly on resource write and nothing sweeps them, so an
   * orphan left by a deleted resource is otherwise unreachable.
   */
  async remove(id: string) {
    const tag = await this.prisma.tag.findUnique({
      where: { id },
      include: { _count: { select: { resources: true } } },
    });

    if (!tag) throw new NotFoundException(`Tag ${id} not found`);

    if (tag._count.resources > 0) {
      throw new ConflictException(
        `Tag ${tag.slug} is still on ${tag._count.resources} resource(s). Detach it with PATCH /resources/:id first.`,
      );
    }

    return (
      this.prisma.tag
        // The count is necessarily 0 by this point — that is what the guard above
        // established — so including it keeps the response shaped like every other
        // tag route rather than being the one that returns a bare row.
        .delete({
          where: { id },
          include: { _count: { select: { resources: true } } },
        })
        .then(toSearchResult)
    );
  }

  /**
   * Backs the contributor-facing typeahead.
   *
   * An empty `query` returns the most-used tags, so browsing the whole
   * vocabulary needs no separate route. Results are ordered by usage count in
   * memory rather than in SQL: a relation `_count` orderBy is not something to
   * rely on across Prisma versions.
   *
   * The limit is applied *after* that sort, never in the query. Capping in SQL
   * can only cap by an orderable column, so the candidate set used to be
   * truncated by `createdAt` first and then ranked by usage — which quietly
   * excluded the most-used tags once more than `SEARCH_RESULT_LIMIT` tags
   * matched. Fetching the matches and slicing the ranked list costs a few more
   * rows from a table that is small by nature, and is the only way the cap
   * lands on the rows that were actually wanted.
   *
   * Matching covers `slug` as well as `name`, because a contributor who has
   * seen `machine-learning` in a URL will type that rather than the display
   * form. Slugs are already lowercased by {@link slugifyTag}, so the query is
   * lowercased to match rather than asking Postgres for a case-insensitive
   * comparison it cannot index.
   */
  async search(query?: string) {
    const trimmed = query?.trim();

    const tags = await this.prisma.tag.findMany({
      where: trimmed
        ? {
            OR: [
              { name: { contains: trimmed, mode: 'insensitive' } },
              { slug: { contains: trimmed.toLowerCase() } },
            ],
          }
        : undefined,
      include: { _count: { select: { resources: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return tags
      .map(toSearchResult)
      .sort((a, b) => b.resourceCount - a.resourceCount)
      .slice(0, SEARCH_RESULT_LIMIT);
  }
}
