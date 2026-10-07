import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { getAuth } from '@clerk/express';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UpdateMySettingsDto } from './dtos/update-my-settings.dto';
import { UpdateMyProfileDto } from './dtos/update-my-profile.dto';
import { RolesGuard } from '../roles/roles.guard';

// `getAuth` throws unless the request carries the branding that
// `clerkMiddleware()` puts there, and only `main.ts` registers that. Same
// approach as `clerk-auth.guard.spec.ts` and the e2e specs: the controller's job
// is to pass the session id through, and the session is Clerk's contract, not
// this codebase's.
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
  clerkClient: { users: { getUser: jest.fn() } },
}));

const mockGetAuth = getAuth as unknown as jest.Mock;
import { PrismaService } from '../prisma/prisma.service';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';

describe('UsersController', () => {
  let controller: UsersController;
  let service: {
    findMySettings: jest.Mock;
    updateMySettings: jest.Mock;
    findMyProfile: jest.Mock;
    updateMyProfile: jest.Mock;
    findByUsername: jest.Mock;
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
            findMyProfile: jest.fn(),
            updateMyProfile: jest.fn(),
            findByUsername: jest.fn(),
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

  describe('findMyProfile', () => {
    it('reads the caller id from the session, not from a param', () => {
      service.findMyProfile.mockReturnValue('result');

      expect(controller.findMyProfile('clerk_123')).toBe('result');
      expect(service.findMyProfile).toHaveBeenCalledWith('clerk_123');
    });
  });

  describe('updateMyProfile', () => {
    it('passes the session id alongside the body', () => {
      const dto: UpdateMyProfileDto = { bio: 'Compiler notes.' };
      service.updateMyProfile.mockReturnValue('result');

      expect(controller.updateMyProfile('clerk_123', dto)).toBe('result');
      expect(service.updateMyProfile).toHaveBeenCalledWith('clerk_123', dto);
    });
  });

  describe('findByUsername', () => {
    it('passes undefined when there is no session', () => {
      mockGetAuth.mockReturnValue({ userId: null });
      service.findByUsername.mockReturnValue('result');

      const result = controller.findByUsername('adal', {} as never);

      expect(service.findByUsername).toHaveBeenCalledWith('adal', undefined);
      expect(result).toBe('result');
    });

    // A private profile's owner has to get through, and only the session can
    // tell the service that they are the owner.
    it('passes the signed-in id so the owner can see their own private profile', () => {
      mockGetAuth.mockReturnValue({ userId: 'clerk_123' });
      service.findByUsername.mockReturnValue('result');

      void controller.findByUsername('adal', {} as never);

      expect(service.findByUsername).toHaveBeenCalledWith('adal', 'clerk_123');
    });
  });

  // The template's create, list, get-one, update and delete routes are gone.
  // This pins that, so a re-added route is a deliberate act rather than an
  // accident of copy-pasting the old controller back. The profile read is not
  // one of them: it is `@Public()`, addresses a handle rather than a Clerk id,
  // and returns a fixed set of fields with no email and no role.
  it('exposes no route for creating, listing, reading, updating or deleting a user by Clerk id', () => {
    const methods = Object.getOwnPropertyNames(
      UsersController.prototype,
    ).filter((name) => name !== 'constructor');

    expect(methods.sort()).toEqual([
      'findByUsername',
      'findMyProfile',
      'findMySettings',
      'updateMyProfile',
      'updateMySettings',
    ]);

    expect(methods).not.toEqual(
      expect.arrayContaining(['create', 'findAll', 'update', 'remove']),
    );
  });

  // A `:username` segment would swallow `me` if it were declared first, and
  // Nest matches routes in declaration order.
  it('declares the profile read after the literal /me/* routes', () => {
    const names = Object.getOwnPropertyNames(UsersController.prototype);
    const byName = (name: string) => names.indexOf(name);

    expect(byName('findByUsername')).toBeGreaterThan(byName('findMySettings'));
    expect(byName('findByUsername')).toBeGreaterThan(byName('findMyProfile'));
  });
});
