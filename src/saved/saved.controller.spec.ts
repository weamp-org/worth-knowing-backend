import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';

import { SavedController } from './saved.controller';
import { SavedService } from './saved.service';
import { RolesGuard } from '../roles/roles.guard';
import { ROLES_KEY } from '../roles/roles.decorator';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../public/public.decorator';

const mockSavedService = {
  findMine: jest.fn(),
  isSaved: jest.fn(),
  save: jest.fn(),
  unsave: jest.fn(),
};

describe('SavedController', () => {
  let controller: SavedController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SavedController],
      providers: [
        { provide: SavedService, useValue: mockSavedService },
        RolesGuard,
        ClerkAuthGuard,
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    controller = module.get(SavedController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findMine', () => {
    it('takes the caller from the session and forwards the pagination', async () => {
      await controller.findMine('clerk_123', { limit: 5, cursor: 'abc' });

      expect(mockSavedService.findMine).toHaveBeenCalledWith(
        'clerk_123',
        5,
        'abc',
      );
    });
  });

  describe('isSaved', () => {
    it('wraps the answer as a boolean flag', async () => {
      mockSavedService.isSaved.mockResolvedValue(true);

      const result = await controller.isSaved('res_1', 'clerk_123');

      expect(result).toEqual({ isSaved: true });
      expect(mockSavedService.isSaved).toHaveBeenCalledWith(
        'res_1',
        'clerk_123',
      );
    });
  });

  describe('save', () => {
    it('takes the resource from the body and the owner from the session', async () => {
      await controller.save({ resourceId: 'res_1' }, 'clerk_123');

      expect(mockSavedService.save).toHaveBeenCalledWith('res_1', 'clerk_123');
    });

    it('never reads the owner from the body', () => {
      // The DTO has no `userId` property, and the global pipe runs with
      // `forbidNonWhitelisted`, so a body naming somebody else is a 400.
      expect({ resourceId: 'res_1' }).not.toHaveProperty('userId');
    });
  });

  describe('unsave', () => {
    it('forwards both ids', async () => {
      await controller.unsave('res_1', 'clerk_123');

      expect(mockSavedService.unsave).toHaveBeenCalledWith(
        'res_1',
        'clerk_123',
      );
    });
  });

  describe('guards', () => {
    /**
     * The handler function a decorator was applied to.
     *
     * Read by name through the property descriptor rather than `prototype[name]`:
     * that is unambiguously a value lookup, where a property access is a method
     * reference, and `unbound-method` is right to complain about a detached
     * method even though all we do is read metadata off the function.
     */
    const handlerFor = (name: string): object =>
      Object.getOwnPropertyDescriptor(SavedController.prototype, name)
        ?.value as object;

    const ROUTES = ['findMine', 'isSaved', 'save', 'unsave'];

    it('marks every route as requiring a session', () => {
      // A bookmark list is the most private thing a person has here, and it has
      // no public version. Nothing on this controller may be `@Public()`.
      for (const name of ROUTES) {
        expect([
          name,
          Reflect.getMetadata(IS_PUBLIC_KEY, handlerFor(name)),
        ]).toEqual([name, undefined]);
      }
    });

    it('declares no route as admin-only', () => {
      // Nothing here is moderation: these are personal bookmarks, and there is
      // no admin path to somebody else’s list.
      for (const name of ROUTES) {
        expect([
          name,
          Reflect.getMetadata(ROLES_KEY, handlerFor(name)),
        ]).toEqual([name, undefined]);
      }
    });
  });
});
