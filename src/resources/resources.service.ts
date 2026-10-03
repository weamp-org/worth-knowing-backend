import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import { UserRole } from '../generated/prisma/enums';
import {
  decodeCursor,
  decodeRankedCursor,
  decodeReportCursor,
  encodeCursor,
  encodeRankedCursor,
  encodeReportCursor,
  isCursorNotFound,
} from '../pagination/cursor.util';
import { DEFAULT_PAGE_SIZE } from '../pagination/pagination-query.dto';
import { CreateResourceDto } from './dtos/create-resource.dto';
import { ReportResourceDto } from './dtos/report-resource.dto';
import { UpdateResourceDto } from './dtos/update-resource.dto';
import {
  buildRankedResourceQuery,
  type RankedResource,
} from './resource-search';
import {
  resourceInclude,
  resourceOrderBy,
  toResourceResponse,
  type ResourceWithRelations,
} from './resource-read';
import {
  resourceReportOrderBy,
  reportResourceInclude,
  toResourceReportResponse,
  type ResourceReportWithResource,
} from './report-read';

/** P2002: a unique index rejected the write. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * The same link, from the same person, twice.
 *
 * Wording matters here. This must not read as a judgement that a duplicate is
 * worthless: two *different* people sharing the same link is the product
 * working, and each `why` is the value. Only the author repeating themselves is
 * noise, so the message points at the edit they probably wanted rather than
 * telling them the resource is not shareable.
 */
const DUPLICATE_MESSAGE =
  'You have already shared this link. Edit that contribution instead of posting it again.';

/** Everything `GET /resources` accepts. Mirrors `ListResourcesQueryDto` plus the viewer. */
export interface ListResourcesOptions {
  tag?: string;
  limit?: number;
  cursor?: string;
  /**
   * Restrict to one contributor, addressed by username.
   *
   * A username rather than the Clerk user id, because this is a public parameter
   * on a `@Public()` route and the id is the primary key of every account on the
   * site — filtering by it would be an enumeration surface.
   */
  contributorUsername?: string;
  /** The signed-in caller, so their own anonymous posts are not redacted from them. */
  viewerId?: string;
  /** Free text. Trimmed, and a blank value means "no search". */
  q?: string;
}

/** The search half of {@link ListResourcesOptions}, once `q` has resolved to a needle. */
interface SearchResourcesOptions {
  needle: string;
  take: number;
  cursor?: { score: number; id: string };
  viewerId?: string;
  tag?: string;
  contributorUsername?: string;
}

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tagsService: TagsService,
  ) {}

  /**
   * Flags a resource for a moderator.
   *
   * The higher-leverage of the two report kinds, and the one that was missing first.
   * A bad *comment* is one person's remark under one page; a bad *resource* is a link
   * that gets shared onward, repeatedly, to people who never saw the flag. That is
   * why `ResourceReport` is a table of its own rather than folded into the comment
   * one — see its doc comment for the Postgres reason that forces it.
   *
   * Idempotent, for the same reason reporting a comment is: the composite primary key
   * refuses the duplicate and `skipDuplicates` is race-safe in a way a read-then-write
   * is not. It also stops one account padding a resource's report count to make it
   * look worse than it is.
   *
   * Reporting your own contribution is refused. The contributor can delete it — that
   * is the self-service correction this API already offers, and `DELETE /resources/:id`
   * is reachable by them — so a report from the author is never what is needed, and a
   * queue containing one is a queue a moderator has to read past.
   *
   * `204`, and the resource looks exactly as it did before. A report is invisible to
   * every reader, **including the contributor**: telling them would turn a quiet
   * signal into a scoreboard, and unlike a deletion it has no effect they might
   * otherwise need to know about.
   */
  async report(
    resourceId: string,
    reporterId: string,
    dto: ReportResourceDto,
  ): Promise<void> {
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      select: { id: true, contributorId: true },
    });

    if (!resource)
      throw new NotFoundException(`Resource ${resourceId} not found`);

    if (resource.contributorId === reporterId) {
      throw new BadRequestException('You cannot report your own contribution');
    }

    await this.prisma.resourceReport.createMany({
      data: {
        reporterId,
        resourceId,
        reason: dto.reason,
        ...(dto.detail?.trim() ? { detail: dto.detail.trim() } : {}),
      },
      skipDuplicates: true,
    });

    // A repeat report from the same person after a dismissal. The insert above is a
    // no-op in that case — the row exists and the composite primary key stops a second
    // one — so without this the reporter is silently ignored while the endpoint still
    // answers 204. Reporting something again is new information: the link they
    // flagged is still there.
    await this.reopenDismissedForReporter(resourceId, reporterId);
  }

  /**
   * Reopens a dismissed contribution's reports **for one reporter**, because that
   * person reported it again.
   *
   * See {@link CommentsService.reopenDismissedForReporter} — the same shape, and the
   * same bug it fixes. Dismissal is per `(target, reporter)` row, so a repeat report
   * from the *same* person hits the composite primary key, `skipDuplicates` inserts
   * nothing, and the stale row keeps `dismissedAt` set. Without this, a reader who
   * reports something, sees a moderator keep it, and reports it again gets a `204`
   * and no queue entry.
   *
   * Called only from {@link report}, which is the sole place a repeat can arrive.
   *
   * `createdAt` is refreshed as well as `dismissedAt`, and that is load-bearing. The
   * queue orders by `createdAt DESC`, so reopening a row while leaving its original
   * date puts a link that was flagged *right now* at the bottom of the queue, under
   * everything flagged since — reported, and never seen. See
   * {@link CommentsService.reopenDismissedForReporter} for the same point on the
   * comment queue; both order by when somebody last said it was worth a look, not by
   * when it first was.
   */
  private async reopenDismissedForReporter(
    resourceId: string,
    reporterId: string,
  ): Promise<void> {
    await this.prisma.resourceReport.updateMany({
      where: { resourceId, reporterId, dismissedAt: { not: null } },
      data: { dismissedAt: null, createdAt: new Date() },
    });
  }

  /**
   * The resource report queue. Admin only, enforced by `@Roles` on the route.
   *
   * Newest report first, paged over `ResourceReport` rather than `Resource`, because
   * the order here is *when somebody flagged it* — the same reasoning as
   * `SavedService.findMine` and `CommentsService.listReports`. A two-year-old
   * contribution reported yesterday is the newest thing a moderator has to look at,
   * and ordering by the resource's own `createdAt` would bury it at the bottom.
   *
   * One row per report rather than per reported resource, so the ordering is over a
   * plain column instead of an aggregate that changes while somebody is paging.
   */
  async listResourceReports(limit?: number, cursor?: string) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    // Decoded outside the query so the two halves can be named for what they are here.
    // `decodeReportCursor` speaks in `targetId` because the shape is shared with the
    // comment queue; this one points at a resource.
    const position = cursor ? decodeReportCursor(cursor) : null;

    let rows: ResourceReportWithResource[];

    try {
      rows = await this.prisma.resourceReport.findMany({
        orderBy: resourceReportOrderBy,
        take: take + 1,
        // Dismissed reports are invisible, not shown-and-greyed — the same reasoning
        // as the comment queue. See `CommentsService.listReports`.
        where: { dismissedAt: null },
        ...(position
          ? {
              cursor: {
                reporterId_resourceId: {
                  reporterId: position.reporterId,
                  resourceId: position.targetId,
                },
              },
              skip: 1,
            }
          : undefined),
        include: { resource: { include: reportResourceInclude } },
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
      items: items.map((row) => toResourceReportResponse(row)),
      nextCursor:
        hasMore && last
          ? encodeReportCursor(last.resourceId, last.reporterId)
          : null,
    };
  }

  /**
   * Whether this contributor already shared this exact link.
   *
   * The `@@unique([contributorId, url])` index is what actually enforces this;
   * this read exists to produce a 409 with a sentence a person can act on
   * instead of a bare P2002. A 409 also beats letting the write fail, because a
   * contributor who double-submits gets a form error naming the problem rather
   * than a 500.
   *
   * Deliberately *not* global. Two people independently finding the same
   * resource worth knowing is the product working — each brings a different
   * `why`, and deduplicating would throw one of those away, which is the last
   * thing this product should lose. Only a repeated submission by the author is
   * noise, and rejecting that costs nobody else their contribution.
   */
  private async assertNotAlreadyShared(
    url: string,
    contributorId: string,
    /** Excluded, so re-saving a resource without changing its URL is allowed. */
    exceptId?: string,
  ) {
    const existing = await this.prisma.resource.findFirst({
      where: {
        url,
        contributorId,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });

    if (existing) throw new ConflictException(DUPLICATE_MESSAGE);
  }

  async create(dto: CreateResourceDto, contributorId: string) {
    const { tags, isAnonymous, ...fields } = dto;
    const tagRows = this.tagsService.normalizeTags(tags);

    await this.assertNotAlreadyShared(dto.url, contributorId);

    await this.tagsService.ensureTags(tagRows);

    // The standing preference only applies when the client expressed no
    // preference of its own. The resolved value is stored on the resource, so
    // a later change to the setting cannot retroactively alter what was shared.
    const resolvedAnonymous =
      isAnonymous ?? (await this.anonymousByDefault(contributorId));

    try {
      return await this.prisma.resource.create({
        data: {
          ...fields,
          isAnonymous: resolvedAnonymous,
          contributorId,
          tags: { connect: tagRows.map(({ slug }) => ({ slug })) },
        },
        include: resourceInclude,
      });
    } catch (error) {
      // Two submissions that both pass the read above. The index is what
      // actually decides, so a race has to come out the same way as a
      // deliberate duplicate rather than as a 500.
      if (isUniqueViolation(error))
        throw new ConflictException(DUPLICATE_MESSAGE);

      throw error;
    }
  }

  /**
   * The contributor's standing preference.
   *
   * Defaults to `false` when the row is missing, which can only happen if the
   * guard has not provisioned it — better to share publicly than to fail.
   */
  private async anonymousByDefault(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { anonymousByDefault: true },
    });

    return user?.anonymousByDefault ?? false;
  }

  /**
   * Keyset-paginated list.
   *
   * Two orderings behind one endpoint, and therefore **two cursor shapes**.
   *
   * - Without `q`: the ordinary feed, `(createdAt DESC, id DESC)`. The cursor is
   *   a bare id and Prisma resolves the row's position against `orderBy`.
   * - With `q`: relevance, `(score DESC, id DESC)`. The cursor carries the score
   *   as well, because a computed score cannot be read back off the row it sorted.
   *
   * A cursor minted by one is not valid for the other, and each decoder rejects
   * the other's shape rather than paging from an arbitrary place.
   *
   * An options object rather than positional arguments because this list has
   * grown past the point where `findAll(tag, limit, cursor, viewerId,
   * contributor, q)` is readable — three of the six are strings, two of them
   * `string | undefined`, and only one is `number`.
   */
  async findAll({
    tag,
    limit,
    cursor,
    viewerId,
    contributorUsername,
    q,
  }: ListResourcesOptions) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    // A blank `q` is not a search. `?q=` and `?q=%20%20` should be the feed, not
    // an empty page that reads as "nothing matched" — a person who cleared the box
    // did not search for nothing, they stopped searching.
    const needle = q?.trim() ? q.trim() : undefined;

    if (needle) {
      return this.searchResources({
        needle,
        take,
        // Decoded here rather than inside the raw query so a malformed cursor is a
        // 400 before the database is touched at all, matching the unfiltered path.
        cursor: cursor ? decodeRankedCursor(cursor) : undefined,
        viewerId,
        tag,
        contributorUsername,
      });
    }

    // `AND` rather than two ternaries into one object: tag and contributor are
    // independent, and a profile page's listing uses the contributor alone while
    // the feed uses the tag alone, but a caller may send both.
    const where: Prisma.ResourceWhereInput = {
      ...(tag ? { tags: { some: { slug: tag } } } : {}),
      ...(contributorUsername
        ? {
            contributor: { usernameLower: contributorUsername },
            /*
             * Anonymous contributions are excluded from a *profile's* listing,
             * for the same reason `ProfileResponseDto.resourcesCount` excludes
             * them: a profile that listed them would disclose the existence of
             * posts the contributor chose to withhold, and would show the `why`
             * they wrote to explain a decision they asked not to be named for.
             * That is the whole of what the anonymity control promises.
             *
             * Applied only when filtering by contributor. The global feed is a
             * different thing — an anonymous post is public *content*, merely
             * unattributed, and dropping it from the feed would remove something
             * a reader was always allowed to see.
             *
             * The consequence is that a contributor cannot see their own
             * anonymous posts on their profile. They can still find and edit
             * them: the rows are unchanged, and the global feed still carries
             * them.
             */
            isAnonymous: false,
          }
        : {}),
    };

    let rows: ResourceWithRelations[];

    try {
      rows = await this.prisma.resource.findMany({
        where: Object.keys(where).length > 0 ? where : undefined,
        orderBy: resourceOrderBy,
        take: take + 1,
        ...(cursor
          ? { cursor: { id: decodeCursor(cursor) }, skip: 1 }
          : undefined),
        include: resourceInclude,
      });
    } catch (error) {
      // A well-formed cursor whose row no longer exists surfaces from Prisma as
      // P2025. That is a client error, not a server fault, and it should not leak
      // the driver's error text.
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items: items.map((row) => toResourceResponse(row, viewerId)),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  /**
   * Relevance-ranked search. See `resource-search.ts` for why the query is raw
   * SQL and why it returns ids rather than rows.
   *
   * Note what is *absent* compared with {@link findAll}: no `isCursorNotFound`
   * handling. This path does not use Prisma's `cursor`, so a cursor whose row was
   * deleted while somebody was paging produces an ordinary empty or short page from
   * the row-value comparison, which is the behaviour that case wants. There is no
   * P2025 to catch because there is no cursor lookup to fail.
   */
  private async searchResources({
    needle,
    take,
    cursor,
    viewerId,
    tag,
    contributorUsername,
  }: SearchResourcesOptions) {
    const ranked = await this.prisma.$queryRaw<RankedResource[]>(
      buildRankedResourceQuery({
        needle,
        take: take + 1,
        tag,
        contributorUsername,
        cursor,
      }),
    );

    const hasMore = ranked.length > take;
    const page = hasMore ? ranked.slice(0, take) : ranked;
    const last = page.at(-1);

    // Nothing matched. Returning early also skips the second query, which would
    // otherwise run `id IN ()` to prove there was nothing to fetch.
    if (page.length === 0) {
      return { items: [], nextCursor: null };
    }

    const rows = await this.prisma.resource.findMany({
      where: { id: { in: page.map((hit) => hit.id) } },
      include: resourceInclude,
    });

    // `findMany` hands rows back in whatever order it found them by, which is not
    // the ranking, and `id: { in: [...] }` does not promise to preserve the
    // array's order. So the order is rebuilt from `page`, which does.
    //
    // A row missing from `rows` — deleted between the two queries — is dropped
    // rather than faked, leaving a page one short. Stopping instead would fail a
    // search on a site whose whole premise is that people take things down.
    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      items: page.flatMap((hit) => {
        const row = byId.get(hit.id);
        return row ? [toResourceResponse(row, viewerId)] : [];
      }),
      nextCursor:
        hasMore && last ? encodeRankedCursor(last.score, last.id) : null,
    };
  }

  async findOne(id: string, viewerId?: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id },
      include: resourceInclude,
    });

    if (!resource) throw new NotFoundException(`Resource ${id} not found`);

    return toResourceResponse(resource, viewerId);
  }

  /**
   * Whether the caller contributed this resource.
   *
   * Separate from the response body because a caller who cannot see the
   * contributor still needs to know whether the resource is theirs — that is
   * what decides whether an edit affordance is shown.
   */
  async isMine(id: string, viewerId: string): Promise<boolean> {
    const resource = await this.prisma.resource.findUnique({
      where: { id },
      select: { contributorId: true },
    });

    return resource?.contributorId === viewerId;
  }

  /**
   * Whether the actor may change or remove the resource, and throws if not.
   *
   * The contributor, or any admin. This lives in the service rather than behind
   * `@Roles` on the controller because `RolesGuard` short-circuits with
   * `if (!requiredRoles) return true` — a route that must accept *either* an
   * owner or an admin cannot be expressed with that decorator, so nothing would
   * ever ask what role the caller has. Deciding here keeps the rule in one
   * place for both writes.
   *
   * Without it, any signed-in user could flip `isAnonymous` on someone else's
   * contribution and undo the one control the anonymity feature exists to
   * provide — or delete a contribution outright. The local `User.id` is the
   * Clerk user id, so the comparison is direct.
   */
  private async assertCanModify(id: string, actorId: string) {
    // Read as the actor rather than anonymously. For the owner that leaves
    // `contributorId` populated, which is exactly what the check below needs;
    // reading it redacted would null that field and lock the owner out of their
    // own anonymous resource.
    const existing = await this.findOne(id, actorId);

    if (existing.contributorId === actorId) return;

    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true },
    });

    if (actor?.role !== UserRole.ADMIN) {
      throw new ForbiddenException('You can only change your own resources');
    }
  }

  async update(id: string, dto: UpdateResourceDto, actorId: string) {
    await this.assertCanModify(id, actorId);

    // Only when the URL is actually changing. Re-saving a resource without
    // touching its URL must not trip the check against itself, hence the
    // exclusion of this resource's own row.
    //
    // `data.url` is typed as the Prisma field-update shape, so a plain string
    // needs unwrapping. An admin editing somebody else's resource is still
    // checked against *that* contributor's other resources, not the admin's:
    // the index is on `(contributorId, url)`, so moving a contribution onto a
    // link its own author already used is the collision that matters.
    if (typeof dto.url === 'string') {
      const owner = await this.prisma.resource.findUnique({
        where: { id },
        select: { contributorId: true },
      });

      if (owner?.contributorId) {
        await this.assertNotAlreadyShared(dto.url, owner.contributorId, id);
      }
    }

    const { tags, ...fields } = dto;
    const data: Prisma.ResourceUpdateInput = { ...fields };

    // `isAnonymous` is absent from a partial update that did not mention it.
    // Spreading `undefined` into a Prisma update is not a way to leave a column
    // alone, so an explicit `null` is dropped here too.
    if (data.isAnonymous === null) {
      delete data.isAnonymous;
    }

    // `tags` is absent from a partial update that did not mention it. Setting
    // it unconditionally would silently strip every tag off the resource.
    if (tags !== undefined) {
      const tagRows = this.tagsService.normalizeTags(tags);

      await this.tagsService.ensureTags(tagRows);

      // `set` replaces the whole set; `connect` would only ever add.
      data.tags = { set: tagRows.map(({ slug }) => ({ slug })) };
    }

    try {
      return await this.prisma.resource.update({
        where: { id },
        data,
        include: resourceInclude,
      });
    } catch (error) {
      // Same reason as in `create`: the index decides, and a losing racer must
      // surface the same 409 a deliberate duplicate gets.
      if (isUniqueViolation(error))
        throw new ConflictException(DUPLICATE_MESSAGE);

      throw error;
    }
  }

  /**
   * Marks every report on a contribution as dealt with, without touching it.
   *
   * "I looked at this and it stays" — the counterpart to removing it. Without this a
   * moderator cannot close anything out, so the queue either grows forever or gets
   * ignored, and both make the next real report less likely to be caught.
   *
   * **Every report for the resource at once.** A resource five people reported is
   * five rows; dismissing one would leave four, which is to say the queue could never
   * be worked through.
   *
   * Worth being explicit that this is not the mild version of removing. A
   * `BROKEN_LINK` report on a carefully written `why` is often a fix rather than a
   * deletion, and this is how a moderator records having decided to keep it.
   *
   * Idempotent and `204` either way, for the reason on
   * {@link CommentsService.dismiss}. Not a delete — the contribution and the report
   * rows stay, and un-dismissing is `dismissedAt = null` rather than an insert to undo.
   *
   * Takes no actor id; `dismissedAt` records *when*, not *who*. See
   * `ResourceReport.dismissedAt`.
   */
  async dismiss(resourceId: string): Promise<void> {
    await this.prisma.resourceReport.updateMany({
      where: { resourceId, dismissedAt: null },
      data: { dismissedAt: new Date() },
    });
  }

  /**
   * Puts a dismissed contribution's reports back in the queue.
   *
   * The inverse of {@link dismiss}, and the reason dismissal needs no confirmation
   * dialog: without a way back, a mis-click would be permanent in practice.
   *
   * Offered by the client as an **Undo on the toast** rather than as a dialog asking
   * first. A dialog costs an extra click on the *safe* action to guard against one rare
   * mistake, and a dialog on every moderation action is how people learn to click
   * through them — including the remove one, which is the only one that genuinely
   * needs reading.
   *
   * Only rows a dismissal actually closed are reopened. A report filed after the
   * dismissal is already `dismissedAt: null` and already queued, so this leaves it
   * alone rather than disturbing a report nobody resolved.
   *
   * Idempotent, and `204` either way.
   */
  async undismiss(resourceId: string): Promise<void> {
    await this.prisma.resourceReport.updateMany({
      where: { resourceId, dismissedAt: { not: null } },
      data: { dismissedAt: null },
    });
  }

  async remove(id: string, actorId: string) {
    await this.assertCanModify(id, actorId);

    // `include` so the response matches the `ResourceResponseDto` the route
    // documents. It costs a second query for a body the client ignores, but the
    // alternative is a documented shape the endpoint does not actually return.
    return this.prisma.resource.delete({
      where: { id },
      include: resourceInclude,
    });
  }
}
