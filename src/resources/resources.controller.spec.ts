import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';

import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { AccessType, ResourceType } from '../generated/prisma/enums';
import { RolesGuard } from '../roles/roles.guard';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

const mockResourcesService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

const createDto = {
  title: 'Sapiens',
  url: 'https://example.com/sapiens',
  type: ResourceType.BOOK,
  accessType: AccessType.PAID,
  why: 'Worth it.',
};

describe('ResourcesController', () => {
  let controller: ResourcesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ResourcesController],
      providers: [
        { provide: ResourcesService, useValue: mockResourcesService },
        RolesGuard,
        ClerkAuthGuard,
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    controller = module.get(ResourcesController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('passes the caller as the contributor', async () => {
      await controller.create('clerk_123', createDto);

      expect(mockResourcesService.create).toHaveBeenCalledWith(
        createDto,
        'clerk_123',
      );
    });
  });

  describe('findAll', () => {
    it('forwards every pagination argument', async () => {
      await controller.findAll({
        tag: 'machine-learning',
        limit: 10,
        cursor: 'Y2tz',
      });

      expect(mockResourcesService.findAll).toHaveBeenCalledWith(
        'machine-learning',
        10,
        'Y2tz',
      );
    });

    it('passes undefined for absent query parameters', async () => {
      await controller.findAll({});

      expect(mockResourcesService.findAll).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('findOne', () => {
    it('passes the id through as a string', async () => {
      await controller.findOne('res_1');

      expect(mockResourcesService.findOne).toHaveBeenCalledWith('res_1');
    });
  });

  describe('update', () => {
    it('passes the id and DTO through', async () => {
      await controller.update('res_1', { title: 'New' });

      expect(mockResourcesService.update).toHaveBeenCalledWith('res_1', {
        title: 'New',
      });
    });
  });

  describe('remove', () => {
    it('passes the id through', async () => {
      await controller.remove('res_1');

      expect(mockResourcesService.remove).toHaveBeenCalledWith('res_1');
    });
  });
});
