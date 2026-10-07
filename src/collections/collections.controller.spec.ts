import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

// `getAuth` throws unless Clerk's middleware has decorated the request, which
// never happens in a unit test. Mocked so these specs stay about argument
// forwarding rather than about Clerk's internals. The `mock` prefix is what
// lets a `jest.mock` factory close over a module-scope variable.
interface MockAuth {
  userId: string | null;
}

let mockAuth: MockAuth = { userId: 'user_1' };

jest.mock('@clerk/express', () => ({
  getAuth: (): MockAuth => mockAuth,
}));

import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { RolesGuard } from '../roles/roles.guard';
import { ROLES_KEY } from '../roles/roles.decorator';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../public/public.decorator';

const mockCollectionsService = {
  create: jest.fn(),
  findMine: jest.fn(),
  findPublic: jest.fn(),
  findOne: jest.fn(),
  listResources: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  addResource: jest.fn(),
  removeResource: jest.fn(),
};

const request = {} as Request;

const createDto = { title: 'Reading list', description: 'Worth it.' };

describe('CollectionsController', () => {
  let controller: CollectionsController;

  beforeEach(async () => {
    mockAuth = { userId: 'user_1' };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CollectionsController],
      providers: [
        { provide: CollectionsService, useValue: mockCollectionsService },
        RolesGuard,
        ClerkAuthGuard,
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    controller = module.get(CollectionsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findMine', () => {
    it('passes the caller as the owner', async () => {
      await controller.findMine('clerk_123', {});

      expect(mockCollectionsService.findMine).toHaveBeenCalledWith(
        'clerk_123',
        undefined,
        undefined,
        undefined,
      );
    });

    it('forwards the resource membership filter and the pagination', async () => {
      await controller.findMine('clerk_123', {
        resourceId: 'res_1',
        limit: 5,
        cursor: 'abc',
      });

      expect(mockCollectionsService.findMine).toHaveBeenCalledWith(
        'clerk_123',
        'res_1',
        5,
        'abc',
      );
    });
  });

  describe('findPublic', () => {
    it('forwards the owner filter and the pagination', async () => {
      await controller.findPublic({ owner: 'adal', limit: 5 }, request);

      expect(mockCollectionsService.findPublic).toHaveBeenCalledWith(
        'adal',
        5,
        undefined,
        'user_1',
      );
    });

    it('reads the session so an owner is told they own their own public collections', async () => {
      await controller.findPublic({}, request);

      expect(mockCollectionsService.findPublic).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        'user_1',
      );
    });

    it('passes undefined for a signed-out reader', async () => {
      mockAuth = { userId: null };

      await controller.findPublic({}, request);

      expect(mockCollectionsService.findPublic).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('findOne', () => {
    it('reads the session even on a public route, so an owner gets through', async () => {
      await controller.findOne('col_1', request);

      expect(mockCollectionsService.findOne).toHaveBeenCalledWith(
        'col_1',
        'user_1',
      );
    });

    it('passes undefined for a signed-out reader', async () => {
      mockAuth = { userId: null };

      await controller.findOne('col_1', request);

      expect(mockCollectionsService.findOne).toHaveBeenCalledWith(
        'col_1',
        undefined,
      );
    });
  });

  describe('listResources', () => {
    it('forwards the viewer and the pagination', async () => {
      await controller.listResources(
        'col_1',
        { limit: 5, cursor: 'abc' },
        request,
      );

      expect(mockCollectionsService.listResources).toHaveBeenCalledWith(
        'col_1',
        'user_1',
        5,
        'abc',
      );
    });

    it('passes undefined for a signed-out reader', async () => {
      mockAuth = { userId: null };

      await controller.listResources('col_1', {}, request);

      expect(mockCollectionsService.listResources).toHaveBeenCalledWith(
        'col_1',
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('create', () => {
    it('passes the caller as the owner', async () => {
      await controller.create('clerk_123', createDto);

      expect(mockCollectionsService.create).toHaveBeenCalledWith(
        createDto,
        'clerk_123',
      );
    });

    it('never reads the owner from the body', () => {
      // `forbidNonWhitelisted` would reject it as a 400, and the DTO has no
      // `ownerId` property for it to bind to. Asserted because a body that named
      // somebody else would be the worst possible bug in this controller.
      expect(createDto).not.toHaveProperty('ownerId');
    });
  });

  describe('update', () => {
    it('forwards the id, the body and the caller', async () => {
      await controller.update('col_1', { title: 'Renamed' }, 'clerk_123');

      expect(mockCollectionsService.update).toHaveBeenCalledWith(
        'col_1',
        { title: 'Renamed' },
        'clerk_123',
      );
    });
  });

  describe('remove', () => {
    it('forwards the id and the caller', async () => {
      await controller.remove('col_1', 'clerk_123');

      expect(mockCollectionsService.remove).toHaveBeenCalledWith(
        'col_1',
        'clerk_123',
      );
    });
  });

  describe('addResource', () => {
    it('forwards the resource id from the body', async () => {
      await controller.addResource(
        'col_1',
        { resourceId: 'res_1' },
        'clerk_123',
      );

      expect(mockCollectionsService.addResource).toHaveBeenCalledWith(
        'col_1',
        'res_1',
        'clerk_123',
      );
    });
  });

  describe('removeResource', () => {
    it('forwards both ids from the path', async () => {
      await controller.removeResource('col_1', 'res_1', 'clerk_123');

      expect(mockCollectionsService.removeResource).toHaveBeenCalledWith(
        'col_1',
        'res_1',
        'clerk_123',
      );
    });
  });

  describe('guards', () => {
    /**
     * The handler function a decorator was applied to.
     *
     * Read by name through the property descriptor rather than as
     * `prototype[name]`: that is unambiguously a value lookup, where a property
     * access on the prototype is a method reference, and `@typescript-eslint`'s
     * `unbound-method` is right to complain about a detached method even though
     * all we do here is read metadata off the function object. It also turns a
     * misspelled name into `undefined` rather than a silent `undefined` method.
     */
    const handlerFor = (name: string): object =>
      Object.getOwnPropertyDescriptor(CollectionsController.prototype, name)
        ?.value as object;

    const WRITE_ROUTES = [
      'create',
      'findMine',
      'update',
      'remove',
      'addResource',
      'removeResource',
    ];

    const PUBLIC_ROUTES = ['findPublic', 'findOne', 'listResources'];

    it('declares no route as admin-only, because ownership is decided in the service', () => {
      // `@Roles` cannot express "owner or admin": `RolesGuard` short-circuits on
      // `if (!requiredRoles) return true`, so a decorated route would reject the
      // owner and an undecorated one would never check anything. Every write here
      // needs the service, so none of these may carry a role.
      for (const name of WRITE_ROUTES) {
        expect([
          name,
          Reflect.getMetadata(ROLES_KEY, handlerFor(name)),
        ]).toEqual([name, undefined]);
      }
    });

    it('marks exactly the reads that work for a signed-out visitor as public', () => {
      const marked = [...WRITE_ROUTES, ...PUBLIC_ROUTES]
        .filter((name) => Reflect.getMetadata(IS_PUBLIC_KEY, handlerFor(name)))
        .sort();

      expect(marked).toEqual([...PUBLIC_ROUTES].sort());
    });

    it('does not mark any write as public', () => {
      for (const name of WRITE_ROUTES) {
        expect([
          name,
          Reflect.getMetadata(IS_PUBLIC_KEY, handlerFor(name)),
        ]).toEqual([name, undefined]);
      }
    });
  });
});
