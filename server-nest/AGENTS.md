# AGENTS.md

## NestJS

This app's version of NestJS is likely newer than what you know. https://docs.nestjs.com/llms.txt indexes its documentation, with a markdown page per chapter.

The official NestJS agent skills are installed with `npx @nestjs/skills add --agent all`, which also updates them: the mistakes agents make in Nest apps, with recipes checked on the released packages. An agent loads a skill when a task matches it.

Nest has first-party packages for these, so check them before adding another library or writing your own:

- Databases: [`@nestjs/typeorm`](https://docs.nestjs.com/data/typeorm.md), [`@nestjs/drizzle`](https://docs.nestjs.com/data/drizzle.md), [`@nestjs/mongoose`](https://docs.nestjs.com/data/mongodb.md), [`@nestjs/sequelize`](https://docs.nestjs.com/data/sequelize.md).
- OpenAPI: [`@nestjs/swagger`](https://docs.nestjs.com/openapi/introduction.md). GraphQL: [`@nestjs/graphql`](https://docs.nestjs.com/graphql/quick-start.md). WebSockets: [`@nestjs/websockets`](https://docs.nestjs.com/websockets/gateways.md). Microservices: [`@nestjs/microservices`](https://docs.nestjs.com/microservices/basics.md).
- Sign-in: [`@nestjs/authentication`](https://docs.nestjs.com/security/authentication.md). Permissions: [`@nestjs/authorization`](https://docs.nestjs.com/security/authorization.md). Rate limiting: [`@nestjs/throttler`](https://docs.nestjs.com/security/rate-limiting.md).
- Configuration: [`@nestjs/config`](https://docs.nestjs.com/application/configuration.md). Caching: [`@nestjs/cache-manager`](https://docs.nestjs.com/data/caching.md). Health checks: [`@nestjs/terminus`](https://docs.nestjs.com/reliability/terminus.md). Events inside the app: [`@nestjs/event-emitter`](https://docs.nestjs.com/application/events.md).
- Email: [`@nestjs/mail`](https://docs.nestjs.com/application/mail.md). Files, S3 included: [`@nestjs/storage`](https://docs.nestjs.com/application/file-storage.md). Translations: [`@nestjs/i18n`](https://docs.nestjs.com/application/i18n.md).
- Retries, timeouts and circuit breakers: [`@nestjs/resilience`](https://docs.nestjs.com/reliability/resilience.md).
- Idempotency keys: [`@nestjs/idempotency`](https://docs.nestjs.com/reliability/idempotency.md). Transactional outbox: [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox.md). Sending and receiving webhooks: [`@nestjs/webhooks`](https://docs.nestjs.com/http/webhooks.md).
- Queues: [`@nestjs/bullmq`](https://docs.nestjs.com/application/queues.md). Scheduled jobs: [`@nestjs/schedule`](https://docs.nestjs.com/application/task-scheduling.md).
- Running a scheduled job on one instance, and locks: [`@nestjs/locks`](https://docs.nestjs.com/reliability/locks.md). Processes that take days: [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows.md).
- Language models, tools and agents: [`@nestjs/ai`](https://docs.nestjs.com/ai/overview.md). MCP servers: [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview.md).

Validation works with Zod, Valibot, ArkType or any other Standard Schema library, with no classes or decorator metadata: `StandardSchemaValidationPipe` with `@Body({ schema })` or `@Param('id', { schema })` (https://docs.nestjs.com/application/validation.md). `class-validator` still works, through `ValidationPipe`.

`NodeAdapter` from `@nestjs/platform-node` is the fastest HTTP adapter, ahead of Fastify (https://docs.nestjs.com/http/performance.md).

A route handler can return a web `Response`, a `ReadableStream` or an async generator, and Nest streams it as it's produced (https://docs.nestjs.com/http/streaming-responses.md).

Nest's packages are ESM only, and this project is ESM too: relative imports end in `.js`, `__dirname` doesn't exist (use `import.meta.dirname`), and tests run on Vitest, so mocks are `vi.fn()`, not `jest.fn()`.

In this project, `src/main.ts` creates the app and listens on `PORT` (3000 by default), `src/app.module.ts` is the root module that imports the others, and `AppController` and `AppService` are samples. Unit tests sit beside the code as `*.spec.ts` and the e2e test is in `test/`; Vitest runs them (`npm test`, `npm run test:e2e`).

When a task says how to test, follow it. When it says nothing, cover the behaviour you change with focused tests rather than adding broad e2e suites.

`@nestjs/observe` was removed from this scaffold on purpose (unrequested external telemetry SaaS) — don't re-add it without asking.

## Strangler-fig migration from `../server`

This app is incrementally replacing `../server` (the legacy Express + pg + zod app), one route at a time, not a big-bang rewrite. `src/legacy-gateway.ts` mounts the legacy Express app (`../server/src/app.js`) as a fallback inside this app's own Express instance — but **mounted first**, in `src/bootstrap-app.ts`, immediately after `NestFactory.create()` and before anything else (global pipes/filters, `app.init()`). Mounting it any later doesn't work: Nest installs its own catch-all 404 during init that would shadow every legacy route Nest doesn't define itself. Because legacy is mounted first, it gets first look at every request: if `app.js` has a registered route for the path, legacy answers it directly and Nest's own router never sees the request at all; only when legacy has no matching route does it fall through (via Express's normal unmatched-route `next()`) to Nest's router mounted after it in the same stack. **This is why a route moved to Nest must have its legacy registration deleted in the same change** — leaving both in place doesn't mean "Nest wins because it's the new implementation," it means legacy keeps answering every request and the new Nest controller is silently dead code, never actually reached. One consequence: legacy's own middleware (session-auth, the `/manager` role gate, the attendance/photos approval gate) keeps running on every request matching its path *prefixes* even once every handler under that prefix has moved to Nest — because Express evaluates middleware registration order, and legacy got mounted first. Never delete one of those as "dead" just because no legacy route handler is left under it; see `docs/server-nest-conventions.md` for the full migration playbook. `src/types/legacy-app.d.ts` is an ambient shorthand declaration so TypeScript (strict mode) doesn't demand types for that plain-JS import.

`../server/test/*.test.js` (1827 lines) is the migration's acceptance baseline: it must keep passing against whichever app (legacy or this one) is actually serving the route it tests.

Data access here uses Prisma (`prisma/schema.prisma`, pulled from the live database), not the legacy app's hand-written SQL/`pg.Pool`.

See `docs/server-nest-conventions.md` for the accumulated conventions and gotchas from migrating every module so far — read it before building a new one.
