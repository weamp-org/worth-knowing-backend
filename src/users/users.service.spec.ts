import { Test, TestingModule } from '@nestjs/testing';

import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUniqueOrThrow: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get(UsersService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findMySettings', () => {
    it('reads only the preferences, never the identity fields', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        anonymousByDefault: true,
      });

      const result = await service.findMySettings('clerk_123');

      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'clerk_123' },
        // A settings read must not drag back an email or a role.
        select: { anonymousByDefault: true },
      });
      expect(result).toEqual({ anonymousByDefault: true });
    });

    it('throws when the row is missing rather than inventing a default', async () => {
      prisma.user.findUniqueOrThrow.mockRejectedValue(new Error('Not found'));

      await expect(service.findMySettings('ghost')).rejects.toThrow();
    });
  });

  describe('updateMySettings', () => {
    it('writes the preference', async () => {
      prisma.user.update.mockResolvedValue({ anonymousByDefault: true });

      const result = await service.updateMySettings('clerk_123', {
        anonymousByDefault: true,
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'clerk_123' },
        data: { anonymousByDefault: true },
        select: { anonymousByDefault: true },
      });
      expect(result).toEqual({ anonymousByDefault: true });
    });

    // Spreading an absent key would send an explicit null to a non-nullable
    // column, which Prisma rejects.
    it('sends nothing when the body is empty', async () => {
      prisma.user.update.mockResolvedValue({ anonymousByDefault: false });

      await service.updateMySettings('clerk_123', {});

      const [[arg]] = prisma.user.update.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(arg.data).toEqual({});
    });

    it('takes the id from the argument, never from the payload', async () => {
      prisma.user.update.mockResolvedValue({ anonymousByDefault: false });

      await service.updateMySettings('clerk_123', {
        anonymousByDefault: false,
      });

      const [[arg]] = prisma.user.update.mock.calls as unknown as [
        [{ where: { id: string }; data: Record<string, unknown> }],
      ];
      expect(arg.where.id).toBe('clerk_123');
      expect(arg.data).not.toHaveProperty('id');
    });
  });

  describe('remove', () => {
    it('deletes by id', async () => {
      const user = { id: 'clerk_123' };
      prisma.user.delete.mockResolvedValue(user);

      const result = await service.remove('clerk_123');

      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: 'clerk_123' },
      });
      expect(result).toEqual(user);
    });
  });
});
