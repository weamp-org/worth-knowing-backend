import { Test, TestingModule } from '@nestjs/testing';

import { CommentReportsController } from './comment-reports.controller';
import { CommentsService } from './comments.service';
import { ROLES_KEY } from '../roles/roles.decorator';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { RolesGuard } from '../roles/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/enums';

/**
 * The admin queue's access rules.
 *
 * Small on purpose. The queue has one route, and the only thing easy to get wrong
 * about it is who can read it — a moderation surface that leaks is worse than one
 * that does not exist.
 */
describe('CommentReportsController', () => {
  let controller: CommentReportsController;
  let service: { listReports: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommentReportsController],
      providers: [
        {
          provide: CommentsService,
          useValue: {
            listReports: jest
              .fn()
              .mockResolvedValue({ items: [], nextCursor: null }),
          },
        },
        // Registered because `@UseGuards` instantiates both by class reference, even
        // though nothing here executes them.
        ClerkAuthGuard,
        RolesGuard,
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    controller = module.get(CommentReportsController);
    service = module.get(CommentsService);
  });

  it('gates the queue on the ADMIN role', () => {
    // Expressible with `@Roles`, unlike the author-or-admin rules elsewhere: this
    // admits only admins, which is exactly the case the decorator can state. There is
    // no owner of a report queue for a non-admin to be.
    const handler = Object.getOwnPropertyDescriptor(
      CommentReportsController.prototype,
      'findAll',
    )?.value as object;

    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.ADMIN]);
  });

  it('attaches both guards, since auth is opt-in per controller', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      CommentReportsController,
    ) as {
      name: string;
    }[];

    expect(guards.map((guard) => guard.name)).toEqual([
      'ClerkAuthGuard',
      'RolesGuard',
    ]);
  });

  it('forwards the pagination', async () => {
    await controller.findAll({ limit: 5, cursor: 'abc' });

    expect(service.listReports).toHaveBeenCalledWith(5, 'abc');
  });
});
