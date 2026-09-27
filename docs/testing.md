# Testing

## Overview

The project uses [Jest](https://jestjs.io/) for both unit tests (`*.spec.ts`) and e2e tests (`*.e2e-spec.ts`). Unit tests use `ts-jest` to compile TypeScript; e2e tests use a separate Jest config.

---

## Running tests

```bash
# Unit tests
pnpm test

# Unit tests with coverage
pnpm test:cov

# E2E tests
pnpm test:e2e

# Unit tests in watch mode
pnpm test:watch
```

## Unit tests

### Configuration (in `package.json`)

```json
{
  "jest": {
    "moduleNameMapper": {
      "^src/(.*)$": "<rootDir>/$1",
      "^(\\.{1,2}/.*)\\.js$": "$1"
    },
    "rootDir": "src",
    "testRegex": ".*\\.spec\\.ts$",
    "transform": { "^.+\\.ts$": "ts-jest" },
    "testEnvironment": "node"
  }
}
```

Note: the `.js` extension mapper is required because TypeScript's `nodenext` module resolution uses explicit `.js` extensions in imports, but Jest's resolver doesn't strip them automatically.

### Patterns

#### Mocking PrismaService

Use a mock object that mimics the Prisma client interface:

```ts
const mockPrismaService = {
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};
```

Pass it via the module's `providers` override:

```ts
const module = await Test.createTestingModule({
  providers: [
    UsersService,
    { provide: PrismaService, useValue: mockPrismaService },
  ],
}).compile();
```

#### Testing services

```ts
describe('UsersService', () => {
  let service: UsersService;
  let prisma: typeof mockPrismaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get(UsersService);
    prisma = module.get(PrismaService);
  });

  it('should create a user', async () => {
    const dto = { id: '1', name: 'Test', email: 'test@test.com' };
    mockPrismaService.user.create.mockResolvedValue(dto);
    expect(await service.create(dto)).toEqual(dto);
  });
});
```

#### Testing controllers

Mock the service and inject it:

```ts
const mockUsersService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

beforeEach(async () => {
  const module = await Test.createTestingModule({
    controllers: [UsersController],
    providers: [{ provide: UsersService, useValue: mockUsersService }],
  }).compile();

  controller = module.get(UsersController);
});
```

#### Testing guards

`ClerkAuthGuard` and `RolesGuard` both use the `Reflector` to check decorator metadata. Provide a mock execution context:

```ts
const mockReflector = {
  get: jest.fn(),
  getAllAndOverride: jest.fn(),
};

beforeEach(async () => {
  const module = await Test.createTestingModule({
    providers: [
      ClerkAuthGuard,
      RolesGuard,
      { provide: Reflector, useValue: mockReflector },
      { provide: PrismaService, useValue: mockPrismaService },
    ],
  }).compile();

  guard = module.get(ClerkAuthGuard);
});
```

For testing guard logic, create a mock `ExecutionContext`:

```ts
const mockContext = (userId: string | null) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ auth: { userId } }),
    }),
    getHandler: () => null,
    getClass: () => null,
  }) as unknown as ExecutionContext;
```

## E2E tests

### Configuration (`test/jest-e2e.json`)

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" }
}
```

### Patterns

Create the app using `Test.createTestingModule` and override providers to avoid real database connections:

```ts
beforeAll(async () => {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();

  app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
});
```

Use Supertest for HTTP assertions:

```ts
it('GET /api/v1', () => {
  return request(app.getHttpServer()).get('/api/v1').expect(200).expect({
    status: 'ok',
    service: 'worth-knowing-api',
  });
});
```

### Tips

- Always call `await app.close()` in `afterAll` to clean up
- Override any provider that makes external connections (database, Clerk API)
- Set up the global prefix in tests if the app uses one, or the routes will 404
- The global `ValidationPipe` is registered in `main.ts`, not `AppModule`, so an
  e2e app that should exercise DTO validation must opt in:
  `app.useGlobalPipes(new ValidationPipe(validationPipeOptions))`. The options
  live in `src/validation.ts` and are shared with `main.ts` so the two cannot
  drift.

### Mocking Clerk in e2e

Clerk's `getAuth` requires a request whose `auth` property is a function
_branded_ by `clerkMiddleware()`, which only `main.ts` registers. You cannot
fake that from a test — setting `req.auth` to a plain object or function still
makes `getAuth` throw, which surfaces as a 500 rather than the 401 you are
trying to assert.

Mock the module instead, the same way `src/clerk-auth/clerk-auth.guard.spec.ts`
does:

```ts
jest.mock('@clerk/express', () => ({
  getAuth: jest.fn(),
  clerkClient: { users: { getUser: jest.fn() } },
}));
```

Then drive the session from a header:

```ts
(getAuth as jest.Mock).mockImplementation(
  (req: { header?: (name: string) => string | undefined }) => ({
    userId: req.header?.('x-test-user-id') ?? null,
  }),
);
```

This keeps e2e tests free of Clerk keys and network access, and lets you assert
both sides of a guard — 401 when the header is absent, and the success path when
it is present. Remember that `RolesGuard` looks the role up through
`prisma.user.findUnique`, so the `PrismaService` override has to answer that
call too if the route is role-restricted.
