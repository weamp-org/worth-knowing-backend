import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getAuth } from '@clerk/express';

// `getAuth` needs a request branded by `clerkMiddleware()`, which only `main.ts`
// registers. Stubbed here rather than in the e2e suite so the controller spec can
// assert what it forwards without standing up the whole app.
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
}));

import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { CommentReportReason } from '../generated/prisma/enums';
import { IS_PUBLIC_KEY } from '../public/public.decorator';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { RolesGuard } from '../roles/roles.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Whether a handler carries `@Public()`, read the same way the guards read it.
 *
 * Read straight off the metadata rather than through a `Reflector` mock: the guard's
 * own lookup is `getAllAndOverride` over `[handler, class]`, and asserting on the
 * raw key is the same fact stated without a stub that could agree with a broken
 * implementation.
 */
function isPublicOn(method: keyof CommentsController): unknown {
  return Reflect.getMetadata(
    IS_PUBLIC_KEY,
    CommentsController.prototype[method],
  );
}

/**
 * Metadata a decorator left on a handler.
 *
 * Takes the method *name* rather than `prototype[method]`, because pulling a method
 * off the prototype by reference is the unbound-method case the lint rules reject —
 * and nothing here needs to call it, only to read what a decorator attached.
 */
function metadataOn(method: keyof CommentsController, key: string): unknown {
  // Read through the property descriptor rather than off `prototype[method]`
  // directly: `Reflect.getMetadata` wants the function itself, and indexing the
  // prototype to get it is the unbound-method case the lint rules reject. Nothing
  // here calls the method — only reads what a decorator attached to it.
  const descriptor: PropertyDescriptor | undefined =
    Object.getOwnPropertyDescriptor(CommentsController.prototype, method);

  if (!descriptor?.value) return undefined;

  return Reflect.getMetadata(key, descriptor.value as object);
}

/**
 * Guard wiring and route shapes, without the HTTP layer.
 *
 * The e2e suite covers status codes and auth end to end; this is about the things
 * that are easy to get wrong in the decorator stack and invisible from a test that
 * already assumes the guards are attached.
 */
describe('CommentsController', () => {
  let controller: CommentsController;
  let service: {
    findForResource: jest.Mock;
    create: jest.Mock;
    report: jest.Mock;
    remove: jest.Mock;
    listReports: jest.Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommentsController],
      providers: [
        {
          provide: CommentsService,
          useValue: {
            findForResource: jest
              .fn()
              .mockResolvedValue({ items: [], nextCursor: null }),
            create: jest.fn().mockResolvedValue({}),
            report: jest.fn().mockResolvedValue(undefined),
            remove: jest.fn().mockResolvedValue(undefined),
            listReports: jest
              .fn()
              .mockResolvedValue({ items: [], nextCursor: null }),
          },
        },
        // Registered because `@UseGuards` instantiates both by class reference, even
        // though nothing in this suite executes them — the guard *wiring* is what is
        // under test, and Nest resolves the providers while building the controller.
        ClerkAuthGuard,
        RolesGuard,
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    controller = module.get(CommentsController);
    service = module.get(CommentsService);
  });

  describe('guards', () => {
    it('attaches both guards at the controller, since auth is opt-in per controller', () => {
      const guards = Reflect.getMetadata('__guards__', CommentsController) as {
        name: string;
      }[];

      expect(guards.map((guard) => guard.name)).toEqual([
        'ClerkAuthGuard',
        'RolesGuard',
      ]);
    });

    it('marks the listing public, since discussion is public content', () => {
      expect(isPublicOn('findAll')).toBe(true);
    });

    it('leaves create and delete guarded, so an anonymous caller cannot post', () => {
      expect(isPublicOn('create')).toBeUndefined();
      expect(isPublicOn('remove')).toBeUndefined();
    });
  });

  describe('findAll', () => {
    /**
     * A request `getAuth` can be stubbed against.
     *
     * Takes nothing: `getAuth` is mocked below, so what matters is only that a
     * request-shaped value reaches the controller. Passing the user id in as an
     * argument would suggest the request object carries it, which it does not —
     * `getAuth` is what reads the header.
     */
    const asRequest = () => ({ header: () => undefined }) as never;

    it('passes the session through even on a public route, so isMine is right on arrival', async () => {
      (getAuth as jest.Mock).mockReturnValue({ userId: 'user_1' });

      await controller.findAll('res_1', { limit: 5 }, asRequest());

      expect(service.findForResource).toHaveBeenCalledWith(
        'res_1',
        5,
        undefined,
        'user_1',
      );
    });

    it('reads a signed-out request as no viewer rather than as a null id', async () => {
      (getAuth as jest.Mock).mockReturnValue({ userId: null });

      await controller.findAll('res_1', {}, asRequest());

      expect(service.findForResource).toHaveBeenCalledWith(
        'res_1',
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('report', () => {
    it('passes the resource, the comment and the reporter through', async () => {
      await controller.report('res_1', 'cmt_1', 'user_1', {
        reason: CommentReportReason.SPAM,
      });

      expect(service.report).toHaveBeenCalledWith('res_1', 'cmt_1', 'user_1', {
        reason: CommentReportReason.SPAM,
      });
    });

    it('leaves the report guarded, since reporting needs a person to attribute it to', () => {
      expect(isPublicOn('report')).toBeUndefined();
    });

    it('answers 204 with no body, so a report renders as nothing at all', () => {
      // A reported comment looks exactly as it did before. Nothing is shown to
      // anybody — not the author, not other readers — because showing it would turn a
      // quiet signal into a scoreboard.
      expect(metadataOn('report', '__httpCode__')).toBe(HttpStatus.NO_CONTENT);
    });

    it('shares the comment write throttle, so reporting cannot outrun posting', () => {
      expect(metadataOn('create', '__throttle__')).toEqual(
        metadataOn('report', '__throttle__'),
      );
    });
  });

  describe('remove', () => {
    it('passes the resource through, so an id from another thread is a 404', async () => {
      await controller.remove('res_1', 'cmt_1', 'user_1');

      expect(service.remove).toHaveBeenCalledWith('res_1', 'cmt_1', 'user_1');
    });

    it('answers 204 with no body, since there is nothing left to describe', () => {
      // 204 rather than 200-with-a-body: returning an emptied comment would invite a
      // client to render "deleted" from a body that has no text left in it. The e2e
      // suite asserts the status off the wire; this pins the decorator that sets it.
      expect(metadataOn('remove', '__httpCode__')).toBe(HttpStatus.NO_CONTENT);
    });
  });
});
