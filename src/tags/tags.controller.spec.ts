import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';

import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { RolesGuard } from '../roles/roles.guard';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

const mockTagsService = { search: jest.fn() };

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
});
