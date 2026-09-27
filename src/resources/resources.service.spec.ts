import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ResourcesService } from './resources.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccessType, ResourceType } from '../generated/prisma/enums';
import { CreateResourceDto } from './dtos/create-resource.dto';

const createDto = {
  title: 'Sapiens',
  url: 'https://example.com/sapiens',
  type: ResourceType.BOOK,
  accessType: AccessType.PAID,
  why: 'The clearest explanation of human institutions I have read.',
};

describe('ResourcesService', () => {
  let service: ResourcesService;
  let prisma: {
    resource: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourcesService,
        {
          provide: PrismaService,
          useValue: {
            resource: {
              create: jest.fn(),
              findMany: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get(ResourcesService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('attributes the resource to the given contributor', async () => {
      prisma.resource.create.mockResolvedValue(createDto);

      await service.create(createDto, 'clerk_123');

      expect(prisma.resource.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { ...createDto, contributorId: 'clerk_123' },
        }),
      );
    });

    it('never accepts a contributorId from the DTO', async () => {
      prisma.resource.create.mockResolvedValue(createDto);

      await service.create(
        {
          ...createDto,
          contributorId: 'clerk_someone_else',
        } as CreateResourceDto,
        'clerk_123',
      );

      expect(prisma.resource.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { ...createDto, contributorId: 'clerk_123' },
        }),
      );
    });
  });

  describe('findAll', () => {
    it('returns resources newest first', async () => {
      prisma.resource.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.resource.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });
  });

  describe('findOne', () => {
    it('returns the resource when found', async () => {
      prisma.resource.findUnique.mockResolvedValue({ id: 'res_1' });

      const result = await service.findOne('res_1');

      expect(result).toEqual({ id: 'res_1' });
    });

    it('throws NotFoundException when missing', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(service.findOne('res_missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('updates an existing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue({ id: 'res_1' });
      prisma.resource.update.mockResolvedValue({ id: 'res_1', title: 'New' });

      const result = await service.update('res_1', { title: 'New' });

      expect(prisma.resource.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'res_1' },
          data: { title: 'New' },
        }),
      );
      expect(result).toEqual({ id: 'res_1', title: 'New' });
    });

    it('throws NotFoundException rather than updating a missing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(
        service.update('res_missing', { title: 'New' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.resource.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes an existing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue({ id: 'res_1' });
      prisma.resource.delete.mockResolvedValue({ id: 'res_1' });

      const result = await service.remove('res_1');

      expect(prisma.resource.delete).toHaveBeenCalledWith({
        where: { id: 'res_1' },
      });
      expect(result).toEqual({ id: 'res_1' });
    });

    it('throws NotFoundException rather than deleting a missing resource', async () => {
      prisma.resource.findUnique.mockResolvedValue(null);

      await expect(service.remove('res_missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.resource.delete).not.toHaveBeenCalled();
    });
  });
});
