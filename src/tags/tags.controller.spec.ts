import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';

import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { RolesGuard } from '../roles/roles.guard';
import { ROLES_KEY } from '../roles/roles.decorator';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/enums';

const mockTagsService = {
  search: jest.fn(),
  updateName: jest.fn(),
  remove: jest.fn(),
};

describe('TagsController', () => {
  let controller: TagsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TagsController],
      providers: [
        { provide: TagsService, useValue: mockTagsService },
        RolesGuard,
        ClerkAuthGuard,
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    controller = module.get(TagsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('search', () => {
    it('passes the query through', async () => {
      await controller.search({ query: 'machine' });

      expect(mockTagsService.search).toHaveBeenCalledWith('machine');
    });

    it('passes undefined when no query is given', async () => {
      await controller.search({});

      expect(mockTagsService.search).toHaveBeenCalledWith(undefined);
    });
  });

  describe('update', () => {
    it('passes the id and the new display name through', async () => {
      await controller.update('tag_1', { name: 'Machine Learning' });

      expect(mockTagsService.updateName).toHaveBeenCalledWith(
        'tag_1',
        'Machine Learning',
      );
    });
  });

  describe('remove', () => {
    it('passes the id through', async () => {
      await controller.remove('tag_1');

      expect(mockTagsService.remove).toHaveBeenCalledWith('tag_1');
    });
  });

  // Both writes are admin-only, and unlike the resource writes this is
  // expressible with `@Roles`: the rule is "admin", not "owner or admin", so
  // `RolesGuard` has something to look up.
  it('gates both writes on the ADMIN role', () => {
    for (const name of ['update', 'remove']) {
      const handler = Object.getOwnPropertyDescriptor(
        TagsController.prototype,
        name,
      )?.value as object;

      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.ADMIN]);
    }
  });
});
