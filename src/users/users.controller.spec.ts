import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UpdateMySettingsDto } from './dtos/update-my-settings.dto';
import { RolesGuard } from '../roles/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';

describe('UsersController', () => {
  let controller: UsersController;
  let service: {
    findMySettings: jest.Mock;
    updateMySettings: jest.Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            findMySettings: jest.fn(),
            updateMySettings: jest.fn(),
          },
        },
        RolesGuard,
        ClerkAuthGuard,
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    service = module.get(UsersService);
    controller = module.get(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findMySettings', () => {
    it('reads the caller id from the session, not from a param', () => {
      service.findMySettings.mockReturnValue('result');

      const result = controller.findMySettings('clerk_123');

      expect(service.findMySettings).toHaveBeenCalledWith('clerk_123');
      expect(result).toBe('result');
    });
  });

  describe('updateMySettings', () => {
    it('passes the session id alongside the body', () => {
      const dto: UpdateMySettingsDto = { anonymousByDefault: true };
      service.updateMySettings.mockReturnValue('result');

      const result = controller.updateMySettings('clerk_123', dto);

      expect(service.updateMySettings).toHaveBeenCalledWith('clerk_123', dto);
      expect(result).toBe('result');
    });
  });

  describe('remove', () => {
    it('is gone, along with the rest of the template CRUD', () => {
      expect(
        (UsersController.prototype as { remove?: unknown }).remove,
      ).toBeUndefined();
    });
  });

  // The template's create, list, get-one, update and delete routes are gone.
  // This pins that, so a re-added route is a deliberate act rather than an
  // accident of copy-pasting the old controller back.
  it('exposes no route for creating, listing, reading, updating or deleting a user by id', () => {
    const methods = Object.getOwnPropertyNames(
      UsersController.prototype,
    ).filter((name) => name !== 'constructor');

    expect(methods.sort()).toEqual(['findMySettings', 'updateMySettings']);
  });
});
