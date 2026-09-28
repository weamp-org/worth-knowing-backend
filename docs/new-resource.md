# Adding a new resource

This guide walks through adding a **Posts** resource as an example — from schema to endpoint.

---

## 1. Add the model to Prisma schema

Edit `prisma/schema.prisma`:

```prisma
model Post {
  id            String   @id @default(cuid())
  title         String
  content       String?
  published     Boolean  @default(false)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  contributorId String?
  contributor   User?    @relation(fields: [contributorId], references: [id], onDelete: SetNull)

  tags Tag[]

  @@index([contributorId])
  @@index([createdAt])
}
```

Name the relation **`contributor`**, not `author`. The person who shares a
resource is not its author, and `authorId` on a resource reads as "who wrote
this book". AGENTS.md uses _contributor_ throughout for this reason.

Make `contributorId` **nullable** with `onDelete: SetNull` rather than a plain
required relation. The `user.deleted` webhook hard-deletes the local `User` row,
so a required foreign key would raise a constraint violation there and leak the
row. See `docs/prisma.md` for the full reasoning.

`tags` is an implicit many-to-many. Free-form tags need two fields — a display
`name` and a normalized unique `slug` — and are created implicitly on resource
write, so do not add a `POST /tags`. `docs/prisma.md` covers the normalization
rules and the `#`-encoding caveat for tag URLs.

Run the migration and regenerate the client:

```bash
pnpm prisma migrate dev --name add_post_model
pnpm prisma generate
```

---

## 2. Scaffold the module

```bash
pnpm exec nest g res posts --type rest --crud
```

This is the non-interactive form of the generator. `--type rest` and `--crud`
answer the two prompts the CLI would otherwise ask (transport layer, CRUD
entry points), so it runs without any input. Omit `--crud` to scaffold a
module with no controller. The generator registers the module in
`src/app.module.ts` for you; add `--skip-import` to manage that by hand.

**Naming:** pass the resource name **plural** — `nest g res posts`, not
`nest g res post` — so the directory, files, and class names all come out
matching the existing `users/` and `webhooks/` modules. The route is
`@Controller('posts')`.

### Post-generation cleanup

The generator emits `dto/` and `entities/`, which this repo does not use —
Prisma is the source of truth for entity shapes, and every existing module
uses a plural `dtos/` directory. Fix both up immediately:

```bash
git mv src/posts/dto src/posts/dtos
rm -r src/posts/entities
```

This leaves:

```text
src/posts/
├── posts.module.ts
├── posts.controller.ts
├── posts.service.ts
├── posts.controller.spec.ts
├── posts.service.spec.ts
└── dtos/
    ├── create-post.dto.ts
    └── update-post.dto.ts
```

Three more things the generator gets wrong relative to this repo's conventions:

- The import it adds to `src/app.module.ts` **omits the `.js` extension**
  (`./posts/posts.module`) that every other import in that file carries.
  Add it.
- There is no `--format` flag, so generated files are unformatted. The
  pre-commit hook's `prettier --write` handles this, but run
  `pnpm lint:fix` if you want it before committing.
- The generated service ignores its DTO arguments, so `@typescript-eslint/no-unused-vars`
  fails until the service has a real implementation (step 4). If you commit
  the bare scaffold, use `--no-verify`.

---

## 3. Update DTOs with validation

**`src/posts/dtos/create-post.dto.ts`**

Use JSDoc comments rather than `@ApiProperty()`. `nest-cli.json` runs the
Swagger plugin with `introspectComments: true`, so comments are converted
into OpenAPI metadata at build time — see
`src/resources/dtos/create-resource.dto.ts`.

```ts
import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class CreatePostDto {
  /** The post title
   * @example 'My First Post'
   */
  @IsString()
  @IsNotEmpty()
  title: string;

  /** The post body
   * @example 'Some content'
   */
  @IsString()
  @IsOptional()
  content?: string;

  /** Whether the post is visible to others
   * @example false
   */
  @IsBoolean()
  @IsOptional()
  published?: boolean;
}
```

**Do not put the contributor in the DTO.** Never accept a contributor (or
author, or user) id from the request body — a client could then attribute a
resource to anyone. Read it from the authenticated session instead and pass it
to the service separately:

```ts
@Post()
create(
  @CurrentUserId() contributorId: string,
  @Body() createPostDto: CreatePostDto,
) {
  return this.postsService.create(createPostDto, contributorId);
}
```

`CurrentUserId` lives in `src/clerk-auth/current-user.decorator.ts` and is only
usable on routes behind `ClerkAuthGuard`.

Remember that the global `ValidationPipe` uses `whitelist: true` **and**
`forbidNonWhitelisted: true`. A property without a `class-validator`
decorator is rejected with a 400, so every field needs one — including
optional ones.

**`src/posts/dtos/update-post.dto.ts`**

```ts
import { PartialType } from '@nestjs/swagger';

import { CreatePostDto } from './create-post.dto';

export class UpdatePostDto extends PartialType(CreatePostDto) {}
```

Use `OmitType` when a create-only field (an author-supplied `id`, for
instance) must not be updatable — see
`src/resources/dtos/update-resource.dto.ts`.

---

## 4. Update the service

**`src/posts/posts.service.ts`**

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostDto } from './dtos/create-post.dto';
import { UpdatePostDto } from './dtos/update-post.dto';

@Injectable()
export class PostsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreatePostDto) {
    return this.prisma.post.create({ data: dto });
  }

  findAll() {
    return this.prisma.post.findMany();
  }

  async findOne(id: string) {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post) throw new NotFoundException(`Post ${id} not found`);
    return post;
  }

  update(id: string, dto: UpdatePostDto) {
    return this.prisma.post.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.post.delete({ where: { id } });
  }
}
```

### If the model has tags

Two rules that are easy to get wrong:

**Replace, don't append.** `set` replaces the whole tag set; `connect` only ever
adds, which makes removing a tag impossible. See
`src/resources/resources.service.ts` for the working version.

**Never set tags unconditionally on update.** `UpdatePostDto` extends
`PartialType`, so `tags` is `undefined` on any partial update that did not
mention it. Writing `tags: { set: dto.tags }` unconditionally would silently
strip every tag off the resource:

```ts
const { tags, ...fields } = dto;
const data: Prisma.PostUpdateInput = { ...fields };

if (tags !== undefined) {
  data.tags = { set: tagRows.map(({ slug }) => ({ slug })) };
}
```

---

## 5. Update the controller with auth guards

**`src/posts/posts.controller.ts`**

```ts
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dtos/create-post.dto';
import { UpdatePostDto } from './dtos/update-post.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { RolesGuard } from '../roles/roles.guard';
import { Roles } from '../roles/roles.decorator';
import { Public } from '../public/public.decorator';
import { UserRole } from '../generated/prisma/enums';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post()
  create(@Body() dto: CreatePostDto) {
    return this.postsService.create(dto);
  }

  @Get()
  @Public()
  findAll() {
    return this.postsService.findAll();
  }

  @Get(':id')
  @Public()
  findOne(@Param('id') id: string) {
    return this.postsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePostDto) {
    return this.postsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.postsService.remove(id);
  }
}
```

---

## 6. Update the module

If `PrismaModule` is not already imported (it is `@Global()`, so skip this step — it is automatically available).

Make sure `PostsModule` is imported in `AppModule` (`src/app.module.ts`):

```ts
@Module({
  imports: [
    ConfigModule.forRoot({ ... }),
    ThrottlerModule.forRoot({ ... }),
    PrismaModule,
    UsersModule,
    WebhooksModule,
    PostsModule,          // ← add this line
  ],
  ...
})
export class AppModule {}
```

---

## 7. Write unit tests

**`src/posts/posts.service.spec.ts`**

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PostsService } from './posts.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrismaService = {
  post: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

describe('PostsService', () => {
  let service: PostsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<PostsService>(PostsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
```

**`src/posts/posts.controller.spec.ts`**

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

const mockPostsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

describe('PostsController', () => {
  let controller: PostsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PostsController],
      providers: [{ provide: PostsService, useValue: mockPostsService }],
    }).compile();

    controller = module.get<PostsController>(PostsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
```

---

## 8. Add e2e test (optional)

```ts
// test/posts.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Posts (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        post: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  it('GET /api/v1/posts', () => {
    return request(app.getHttpServer())
      .get('/api/v1/posts')
      .expect(200)
      .expect([]);
  });

  afterAll(async () => {
    await app.close();
  });
});
```

---

## Summary

```text
Schema → Migrate → Scaffold → DTOs → Service → Controller → Module → Test
```

Run the full validation suite when done:

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```
