import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/enums';
import {
  decodeCursor,
  encodeCursor,
  isCursorNotFound,
} from '../pagination/cursor.util';
import {
  resourceInclude,
  toResourceResponse,
  type ResourceWithRelations,
} from '../resources/resource-read';
import {
  resolveDisplayName,
  resolveProfilePath,
} from '../users/display-name.util';
import { CreateCollectionDto } from './dtos/create-collection.dto';
import { UpdateCollectionDto } from './dtos/update-collection.dto';
import { DEFAULT_PAGE_SIZE } from './dtos/list-collections-query.dto';

/**
 * The fields needed to render a byline for a collection's owner.
 *
 * `id` is deliberately absent, unlike the contributor summary on a resource. A
 * collection is never anonymous, so there is no case where the owner is being
 * withheld and the raw id would be the only remaining handle on them.
 */
const ownerSelect = {
  name: true,
  imageUrl: true,
  // Both read only to resolve a display name and a link. Neither reaches the
  // response — see {@link toOwnerSummary}.
  username: true,
  usernameLower: true,
  isProfilePrivate: true,
} as const;

/**
 * Read shape for the collection routes.
 *
 * `_count` rather than loading the resources, because every caller here wants to
 * know how many there are and none of them want all of them — the contents are a
 * separate, paginated route.
 */
const collectionInclude = {
  owner: { select: ownerSelect },
  _count: { select: { resources: true } },
} as const;

/**
 * Newest first, with `id` as a tiebreaker.
 *
 * Same total-order requirement as the resource feed, and for the same reason:
 * `createdAt` is not unique, and a keyset cursor over a non-total order skips or
 * repeats rows. Paired with `Collection_ownerId_createdAt_id_idx`.
 */
const collectionOrderBy = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.CollectionOrderByWithRelationInput[];

type CollectionWithRelations = Prisma.CollectionGetPayload<{
  include: typeof collectionInclude;
}>;

type CollectionResponse = {
  id: string;
  title: string;
  description: string | null;
  isPrivate: boolean;
  createdAt: Date;
  updatedAt: Date;
  owner: {
    name: string | null;
    imageUrl: string | null;
    profilePath: string | null;
  } | null;
  resourceCount: number;
  /**
   * Written as a literal type rather than derived from the row so that adding a
   * field to {@link collectionInclude} cannot quietly widen what the route
   * promises. `CollectionSummaryDto` documents the shape; this is it.
   */
  isOwner: boolean;
};

/**
 * Flattens the owner select and the `_count` into the response shape, dropping
 * the three fields that only exist to be derived.
 */
function toOwnerSummary(
  owner: CollectionWithRelations['owner'],
): CollectionResponse['owner'] {
  // A null owner is meaningful and is passed through: the account was deleted.
  // Re-asserting it here would be right, but forcing it on a row that merely
  // lacked the key would be wrong, and the same reasoning as in
  // `resources/resource-read.ts` applies.
  if (!owner) return null;

  const { username, usernameLower, isProfilePrivate, ...summary } = owner;

  return {
    ...summary,
    name: resolveDisplayName({ name: summary.name, username }),
    profilePath: resolveProfilePath({ usernameLower, isProfilePrivate }),
  };
}

function toCollectionResponse(
  collection: CollectionWithRelations,
  viewerId?: string,
): CollectionResponse {
  return {
    id: collection.id,
    title: collection.title,
    description: collection.description,
    isPrivate: collection.isPrivate,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
    owner: toOwnerSummary(collection.owner),
    resourceCount: collection._count.resources,
    isOwner: collection.ownerId === viewerId,
  };
}

@Injectable()
export class CollectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's own collections, newest first, keyset-paginated.
   *
   * Not paginated by a public route's worth of filters because there is nothing
   * to filter: it is always the caller's own, and the only optional input is the
   * resource whose membership each row reports.
   */
  async findMine(
    ownerId: string,
    resourceId?: string,
    limit?: number,
    cursor?: string,
  ) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    let rows: CollectionWithRelations[];

    try {
      rows = await this.prisma.collection.findMany({
        where: { ownerId },
        orderBy: collectionOrderBy,
        take: take + 1,
        ...(cursor
          ? { cursor: { id: decodeCursor(cursor) }, skip: 1 }
          : undefined),
        include: collectionInclude,
      });
    } catch (error) {
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    // One extra query for the whole page, rather than one per collection. This
    // is the entire reason `?resourceId=` is a filter on this route rather than a
    // separate per-collection check: the picker renders every one of the
    // caller's collections with a saved/unsaved state, and asking individually
    // would be N round trips to draw one list.
    //
    // Skipped entirely when the client did not ask, so the common case — a plain
    // "my collections" page — stays a single query.
    const containing = await this.collectionsContaining(items, resourceId);

    return {
      items: items.map((row) => ({
        ...toCollectionResponse(row, ownerId),
        containsResource: containing.has(row.id),
      })),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  /**
   * Which of these collections already hold `resourceId`.
   *
   * Scoped to the collections on this page, so the query is bounded by the page
   * size rather than by how many collections the caller owns. An id that names
   * no resource simply matches nothing, and every row answers `false` — the
   * picker is about to add it, so that is the right answer either way.
   */
  private async collectionsContaining(
    collections: CollectionWithRelations[],
    resourceId?: string,
  ): Promise<Set<string>> {
    if (!resourceId || collections.length === 0) return new Set();

    const rows = await this.prisma.collectionResource.findMany({
      where: { resourceId, collectionId: { in: collections.map((c) => c.id) } },
      select: { collectionId: true },
    });

    return new Set(rows.map((row) => row.collectionId));
  }

  /**
   * Public collections, newest first, keyset-paginated.
   *
   * Private ones are filtered out in the query rather than checked afterwards,
   * so a private collection cannot appear in a listing, in a count, or in a
   * cursor position.
   *
   * `?owner=` is what a profile page uses. It is the **only** place the product
   * surfaces these: a public collection is a statement by somebody about their
   * taste, which belongs next to the taste they expressed as contributions rather
   * than in a ranked index of its own. The route is unopinionated about that and
   * will list every public collection when called without `owner`, so a global
   * browse is a UI decision later rather than an API change now.
   */
  async findPublic(
    ownerUsername?: string,
    limit?: number,
    cursor?: string,
    viewerId?: string,
  ) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.CollectionWhereInput = {
      isPrivate: false,
      ...(ownerUsername ? { owner: { usernameLower: ownerUsername } } : {}),
    };

    let rows: CollectionWithRelations[];

    try {
      rows = await this.prisma.collection.findMany({
        where,
        orderBy: collectionOrderBy,
        take: take + 1,
        ...(cursor
          ? { cursor: { id: decodeCursor(cursor) }, skip: 1 }
          : undefined),
        include: collectionInclude,
      });
    } catch (error) {
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items: items.map((row) => ({
        ...toCollectionResponse(row, viewerId),
        // Meaningless on a public listing — the question was never asked, and
        // there is no resource to ask it about. See the DTO.
        containsResource: false,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  /**
   * Loads a collection the caller is allowed to see, or throws.
   *
   * A private collection is a **404, not a 403**, and the two cases throw the
   * same message. A 403 would confirm the collection exists, which is itself the
   * answer the owner declined to give — the same reasoning as
   * `UsersService.findByUsername` on a private profile. Sharing one message for
   * "no such collection" and "not yours" means the response is the same either
   * way, so there is nothing to tell apart.
   */
  private async findVisible(
    id: string,
    viewerId?: string,
  ): Promise<CollectionWithRelations> {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      include: collectionInclude,
    });

    if (!collection) throw new NotFoundException(`Collection ${id} not found`);

    if (collection.isPrivate && collection.ownerId !== viewerId) {
      throw new NotFoundException(`Collection ${id} not found`);
    }

    return collection;
  }

  async findOne(id: string, viewerId?: string) {
    return toCollectionResponse(await this.findVisible(id, viewerId), viewerId);
  }

  /**
   * The collection's contents, newest-added first, keyset-paginated.
   *
   * Paged over `CollectionResource` rather than over `Resource`, because the
   * order is the order they were *collected*, which is a property of the
   * assignment and not of the resource. A resource collected today and another
   * collected last week have their own `createdAt` from whoever shared them, and
   * ordering by that would be a different — and wrong — list.
   *
   * The items go through the same redaction as any public resource read, so
   * making a collection public does not deanonymize a contribution inside it.
   * That is the reason `resourceInclude` and `toResourceResponse` were extracted
   * out of `ResourcesService` rather than copied here.
   */
  async listResources(
    id: string,
    viewerId?: string,
    limit?: number,
    cursor?: string,
  ) {
    // Checked before the query, not after: a private collection must not answer
    // an empty page to a stranger, because an empty page is distinguishable
    // from a 404 and would confirm the collection is real.
    await this.findVisible(id, viewerId);

    const take = limit ?? DEFAULT_PAGE_SIZE;

    let rows: {
      resource: ResourceWithRelations;
      resourceId: string;
    }[];

    try {
      rows = await this.prisma.collectionResource.findMany({
        where: { collectionId: id },
        orderBy: [
          { addedAt: 'desc' },
          { resourceId: 'desc' },
        ] satisfies Prisma.CollectionResourceOrderByWithRelationInput[],
        take: take + 1,
        ...(cursor
          ? {
              /*
               * The compound primary key, not `{ resourceId }`.
               *
               * `resourceId` alone is not unique — the same resource can sit in
               * fifty collections — so Prisma would refuse it as a cursor. The
               * pair is unique, and `collectionId` is already known from the path,
               * so the opaque cursor only has to carry the half that varies.
               */
              cursor: {
                collectionId_resourceId: {
                  collectionId: id,
                  resourceId: decodeCursor(cursor),
                },
              },
              skip: 1,
            }
          : undefined),
        include: { resource: { include: resourceInclude } },
      });
    } catch (error) {
      // A resource removed from the collection between pages. Same reasoning as
      // the resource feed: an empty page is right, a 400 is noise.
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items: items.map((row) => toResourceResponse(row.resource, viewerId)),
      nextCursor: hasMore && last ? encodeCursor(last.resourceId) : null,
    };
  }

  async create(dto: CreateCollectionDto, ownerId: string) {
    const { isPrivate, ...fields } = dto;
    const data: Prisma.CollectionCreateInput = {
      owner: { connect: { id: ownerId } },
      ...fields,
    };

    /*
     * Visibility is left out of the payload when the client did not state it, so
     * the column default is the only thing that decides. Prisma would ignore an
     * explicit `undefined` anyway, but a payload that quietly carries a key with
     * no value reads as "this was considered and set to nothing", and the two
     * would only be distinguishable by tracing the database.
     */
    if (isPrivate !== undefined) {
      data.isPrivate = isPrivate;
    }

    const created = await this.prisma.collection.create({
      data,
      include: collectionInclude,
    });

    return toCollectionResponse(created, ownerId);
  }

  /**
   * Re-reads a collection that has just been written to, for the response.
   *
   * The `_count` has to come from a fresh read — that is the whole point of
   * returning the collection from an add or a remove. A null here would mean the
   * collection was deleted between the authorization check and the write, which
   * is a race rather than a state, and 404 is the honest answer to it.
   */
  private async reread(id: string, viewerId: string) {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      include: collectionInclude,
    });

    if (!collection) throw new NotFoundException(`Collection ${id} not found`);

    return toCollectionResponse(collection, viewerId);
  }

  /**
   * Whether the actor may change or remove the collection itself, and throws if
   * not.
   *
   * The owner, or any admin — the same rule `ResourcesService` applies to a
   * contribution, and for the same reason: a public collection is public
   * content, and the product asks for moderation that does not depend on the
   * owner being reachable.
   *
   * In the service rather than behind `@Roles` because `RolesGuard`
   * short-circuits on `if (!requiredRoles) return true`; a route that must
   * accept *either* an owner or an admin cannot be expressed with that decorator,
   * so nothing would ever ask what role the caller has.
   */
  private async assertCanModify(id: string, actorId: string) {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      select: { ownerId: true },
    });

    if (!collection) throw new NotFoundException(`Collection ${id} not found`);

    if (collection.ownerId === actorId) return;

    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true },
    });

    if (actor?.role !== UserRole.ADMIN) {
      throw new ForbiddenException('You can only change your own collections');
    }
  }

  /**
   * Whether the caller owns the collection, and throws if not.
   *
   * Stricter than {@link assertCanModify} on purpose, and the difference is
   * worth stating: renaming a collection or deleting it is moderation — an admin
   * removing a public collection that turns out to be abuse is doing their job.
   * *Adding a resource to somebody's reading list* is not. It is a private
   * arrangement of their taste, there is no content reason for anyone else to
   * have an opinion about it, and an admin quietly inserting a link would be
   * indefensible. So this one is owner-only with no admin path.
   *
   * 404 before 403, matching {@link findVisible}, so a stranger cannot confirm a
   * collection exists by trying to add to it.
   */
  private async assertOwns(id: string, actorId: string) {
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      select: { ownerId: true },
    });

    if (!collection) throw new NotFoundException(`Collection ${id} not found`);

    if (collection.ownerId !== actorId) {
      throw new ForbiddenException('You can only change your own collections');
    }
  }

  async update(id: string, dto: UpdateCollectionDto, actorId: string) {
    await this.assertCanModify(id, actorId);

    const data: Prisma.CollectionUpdateInput = { ...dto };

    /*
     * `description` is absent from a partial update that did not mention it.
     * Spreading `undefined` into a Prisma update is not a way to leave a column
     * alone, so an explicit `undefined` is dropped here.
     *
     * An explicit `null` is kept, and is the only way to *clear* a description.
     * `@IsOptional()` lets `null` through validation, and "remove the paragraph I
     * wrote" is a real thing a person should be able to do — treating it as
     * absent would leave them unable to empty the field at all.
     */
    if (dto.description === undefined) {
      delete data.description;
    }

    const updated = await this.prisma.collection.update({
      where: { id },
      data,
      include: collectionInclude,
    });

    // Read back as the actor, so an owner editing their own collection gets
    // `isOwner: true` rather than the `false` an anonymous read would give.
    return toCollectionResponse(updated, actorId);
  }

  async remove(id: string, actorId: string) {
    const removed = await this.prisma.collection.findUnique({
      where: { id },
      include: collectionInclude,
    });

    await this.assertCanModify(id, actorId);

    // The join rows go with it, by the `Cascade` on `CollectionResource`.
    //
    // Not the 409 `TagsService.remove` uses when a tag still has resources. That
    // guard exists because detaching a tag rewrites contributions other people
    // wrote. Nothing is rewritten here: a join row records that this owner chose
    // this resource for this list, and deleting the list is the owner withdrawing
    // their own organization. The resources inside are untouched and still
    // attributed to whoever shared them.
    await this.prisma.collection.delete({ where: { id } });

    // Read *before* the delete, so the caller gets the collection back rather than
    // a 204. The route documents a `CollectionResponseDto` and returning the
    // deleted row is what makes that true. `assertCanModify` has already thrown
    // if there was no such collection, so this cannot be null — checked anyway,
    // because the two reads are separate and a `!` here would turn a reordering
    // of them into a `TypeError` rather than a 404.
    if (!removed) throw new NotFoundException(`Collection ${id} not found`);

    return toCollectionResponse(removed, actorId);
  }

  /**
   * Puts a resource in the collection.
   *
   * Any resource on the site, not only the caller's own. A collection is how
   * somebody says "these are worth knowing together", and the resources in it
   * are overwhelmingly not theirs — restricting it to their own contributions
   * would leave collections a second, worse view of their profile page.
   *
   * Idempotent. Adding a resource twice is the same end state as adding it once,
   * and a person double-clicking a button should not get a 409 for it. The
   * primary key is what actually prevents a duplicate, and `skipDuplicates` is
   * race-safe in a way a read-then-write check is not — two clicks landing at
   * once both succeed and produce one row, rather than one of them raising P2002.
   *
   * Returns the collection so the caller can render the new count without a
   * second read.
   */
  async addResource(id: string, resourceId: string, actorId: string) {
    await this.assertOwns(id, actorId);

    // Checked before the write so a typo'd id is a 404 naming the problem,
    // rather than a foreign-key violation surfacing as a 500. The FK still
    // enforces it; this exists for the message.
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      select: { id: true },
    });

    if (!resource) {
      throw new NotFoundException(`Resource ${resourceId} not found`);
    }

    await this.prisma.collectionResource.createMany({
      data: { collectionId: id, resourceId },
      skipDuplicates: true,
    });

    return this.reread(id, actorId);
  }

  /**
   * Takes a resource out of the collection.
   *
   * Idempotent for the same reason {@link addResource} is: removing something
   * that is not there is exactly the state the caller asked for, so there is no
   * error to raise.
   */
  async removeResource(id: string, resourceId: string, actorId: string) {
    await this.assertOwns(id, actorId);

    // `deleteMany` rather than `delete`, precisely because "it was not there" is
    // not an error here. The resource itself is not required to exist either: if
    // it was deleted outright its join rows cascaded away, and the caller's
    // request has still been honoured — which is why this is a 200 and not the
    // 404 that `addResource` gives for an unknown resource.
    await this.prisma.collectionResource.deleteMany({
      where: { collectionId: id, resourceId },
    });

    return this.reread(id, actorId);
  }
}
