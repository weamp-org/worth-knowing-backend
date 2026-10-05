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

import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { AccessType, ResourceType } from '../generated/prisma/enums';
import { RolesGuard } from '../roles/roles.guard';
import { ROLES_KEY } from '../roles/roles.decorator';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

const mockResourcesService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  mostSaved: jest.fn(),
  random: jest.fn(),
  isMine: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

const request = {} as Request;

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
    mockAuth = { userId: 'user_1' };

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
    // One options object rather than positional arguments: `q` was the sixth
    // parameter, and at that point the signature was unreadable.
    it('forwards every filter, the pagination arguments and the viewer', async () => {
      await controller.findAll(
        {
          tag: 'machine-learning',
          limit: 10,
          cursor: 'Y2tz',
          contributor: 'adal',
          q: 'sapiens',
        },
        request,
      );

      expect(mockResourcesService.findAll).toHaveBeenCalledWith({
        tag: 'machine-learning',
        limit: 10,
        cursor: 'Y2tz',
        contributorUsername: 'adal',
        q: 'sapiens',
        viewerId: 'user_1',
      });
    });

    it('passes undefined for absent query parameters', async () => {
      await controller.findAll({}, request);

      expect(mockResourcesService.findAll).toHaveBeenCalledWith({
        tag: undefined,
        limit: undefined,
        cursor: undefined,
        contributorUsername: undefined,
        q: undefined,
        viewerId: 'user_1',
      });
    });

    it('forwards no viewer when the request is signed out', async () => {
      mockAuth = { userId: null };

      await controller.findAll({}, request);

      expect(mockResourcesService.findAll).toHaveBeenCalledWith({
        tag: undefined,
        limit: undefined,
        cursor: undefined,
        contributorUsername: undefined,
        q: undefined,
        viewerId: undefined,
      });
    });
  });

  describe('findOne', () => {
    it('passes the id and viewer through', async () => {
      await controller.findOne('res_1', request);

      expect(mockResourcesService.findOne).toHaveBeenCalledWith(
        'res_1',
        'user_1',
      );
    });
  });

  describe('home page rails', () => {
    describe('topSaved', () => {
      it('forwards the limit and the viewer', async () => {
        await controller.topSaved({ limit: 6 }, request);

        expect(mockResourcesService.mostSaved).toHaveBeenCalledWith(
          6,
          'user_1',
        );
      });

      /*
       * `undefined` rather than `0` or a default. The service owns
       * `DEFAULT_TOP_SAVED`, and a controller that substituted its own number
       * would be a second place to change it.
       */
      it('forwards an absent limit as undefined, not a default', async () => {
        await controller.topSaved({}, request);

        expect(mockResourcesService.mostSaved).toHaveBeenCalledWith(
          undefined,
          'user_1',
        );
      });

      it('passes no viewer for a signed-out read', async () => {
        mockAuth = { userId: null };

        await controller.topSaved({}, request);

        expect(mockResourcesService.mostSaved).toHaveBeenCalledWith(
          undefined,
          undefined,
        );
      });
    });

    describe('random', () => {
      it('forwards the viewer', async () => {
        await controller.random(request);

        expect(mockResourcesService.random).toHaveBeenCalledWith('user_1');
      });

      it('passes no viewer for a signed-out read', async () => {
        mockAuth = { userId: null };

        await controller.random(request);

        expect(mockResourcesService.random).toHaveBeenCalledWith(undefined);
      });

      it('never receives a limit, because there is exactly one row', async () => {
        await controller.random(request);

        // A `?limit=` here would be accepted by the global pipe's whitelist and
        // then ignored, which is the same silent-drop the top-saved DTO avoids by
        // not extending a class that carries one.
        expect(mockResourcesService.random).toHaveBeenCalledWith('user_1');
      });
    });
  });

  describe('isMine', () => {
    it('wraps the service answer', async () => {
      mockResourcesService.isMine.mockResolvedValue(true);

      await expect(controller.isMine('res_1', 'user_1')).resolves.toEqual({
        isMine: true,
      });
    });

    it('reports false rather than throwing', async () => {
      mockResourcesService.isMine.mockResolvedValue(false);

      await expect(controller.isMine('res_1', 'user_1')).resolves.toEqual({
        isMine: false,
      });
    });
  });

  describe('update', () => {
    it('passes the id, DTO and caller through', async () => {
      await controller.update('res_1', { title: 'New' }, 'user_1');

      expect(mockResourcesService.update).toHaveBeenCalledWith(
        'res_1',
        { title: 'New' },
        'user_1',
      );
    });
  });

  describe('remove', () => {
    it('passes the id and the caller through', async () => {
      await controller.remove('res_1', 'user_1');

      expect(mockResourcesService.remove).toHaveBeenCalledWith(
        'res_1',
        'user_1',
      );
    });

    // Deleting your own contribution is the only self-service correction the
    // product offers, so this route must reach contributors and not just admins.
    //
    // `@Roles(UserRole.ADMIN)` could not express that anyway: `RolesGuard`
    // short-circuits to `true` for a route that declares no roles, so a rule
    // admitting either an owner or an admin has to be enforced in the service,
    // where the actor's role is actually read.
    it('is not gated on the ADMIN role', () => {
      // The guard reads role metadata off the handler. `RolesGuard` treats
      // absent metadata as "no roles required", so declaring none here is what
      // lets a contributor through — the real owner-or-admin check is in the
      // service, which is the only place that can read the caller's role.
      // Read by name rather than as a property access, so this is unambiguously
      // a value lookup rather than an unbound method reference.
      const handler = Object.getOwnPropertyDescriptor(
        ResourcesController.prototype,
        'remove',
      )?.value as object;

      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    });
  });
});
