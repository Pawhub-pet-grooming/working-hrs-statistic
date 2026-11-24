# server-nest module development conventions

Patterns and gotchas accumulated while migrating every `server/` route to
`server-nest/` (Epics 2-6 of the NestJS migration). Read this before building a
new module or touching an existing one — most of these were each discovered
the hard way once, and are easy to re-break by accident otherwise. For the
general Nest/strangler-fig mechanics (how `legacy-gateway.ts` works, package
conventions, ESM/testing setup), see `server-nest/AGENTS.md` first — this doc
assumes that context and goes one level more specific.

## Module shape

A business-domain module is a `Controller` + `Service` pair (plus a `Module`
wiring them and a `*.schemas.ts` for its Zod request schemas, when it has
request bodies). Cross-cutting concerns that many modules need are their own
`@Global()` modules, imported once in `AppModule`: `DatabaseModule`
(`DbService`, which extends `PrismaClient` directly), `AuditModule`,
`IdempotencyModule`, and `OrganizationModule` (which holds `ScopeService`,
despite the name — it grew there because the first thing that needed shop/
worker-scope checks was `MeModule`, ahead of `OrganizationModule`'s own task).

**Reuse `ScopeService` for any permission check that isn't a static role
list.** It has `allowed()`, `assertShop()`, `assertWorker()`, and
`assertRecordScope()` (shop-or-worker scope: backend-self-worker-check →
`allowed()` → `assertWorker()`). A static role list (`MANAGER`,
`GENERAL_MANAGER`, `SUPER_MANAGER`, ...) still just uses `@Roles(...)` +
`RolesGuard`. Don't write a new scope-check method on a service when one of
these already does what you need — every business module built so far reused
these instead of reimplementing scope logic, and it's the main reason later
modules got faster to build than earlier ones.

## Validation and errors

Request validation is Nest's native `StandardSchemaValidationPipe` with Zod
schemas (`@Body({ schema: someZodSchema })`), registered globally in
`bootstrap-app.ts` with `errorHttpStatusCode: 422` and a custom
`exceptionFactory` that matches legacy's `{ error: { code, message, fields } }`
envelope — don't re-register a pipe per-route, and don't reach for
`nestjs-zod` or `class-validator`; the project deliberately doesn't use either
(see "Deviations from the obvious default" below).

Throw errors via `apiError(status, message, code?)` (`src/common/api-error.ts`)
or a plain Nest `HttpException`; `HttpErrorFilter` renders both into the same
envelope legacy used.

## HTTP status codes — check every migrated route, don't assume

Nest defaults `POST` handlers to `201 Created` and `GET`/others to `200`;
legacy's Express routes mostly returned `200` even for `POST`. **Every
migrated `POST` route needs an explicit `@HttpCode(200)` if legacy returned
200** — check each one individually, don't assume. This has been missed twice
(`ReportsModule`'s first pass, and a validations-decision route) and both times
it was only caught by the full legacy regression suite, never by
`server-nest`'s own fast unit tests (they don't assert real HTTP status
codes). Rebuilding and re-running the regression suite is not optional after
touching any route's status-code-relevant decorators.

**`@Res()` does not exempt a handler from this.** `RouterExecutionContext`
pre-sets the response status *before* invoking the controller method at all,
regardless of whether the method uses `@Res()` — using it only skips Nest's
own body-serialization step after the handler returns, not that earlier
status write. A handler that calls `@Res()` still needs `@HttpCode()`
whenever the legacy status differs from Nest's per-method default. (Confirmed
by reading `@nestjs/core`'s source directly after this exact assumption broke
`ReportsController.pdf()` silently — it started returning 201 for a route
that's supposed to be 200, caught only by the regression suite's status
assertion.)

## The dependency-injection import gotcha

**A constructor-injected provider (anything Nest resolves via `emitDecoratorMetadata`, e.g. `DbService`) must be imported as a value, never `import type`.**
A type-only import erases the class reference DI needs, so Nest throws
`UnknownDependenciesException` at bootstrap (showing the unresolved
parameter's type as literal `Function`). The dangerous part: `createApp({
logger: false })` (used by the legacy test suite's `createCombinedTestServer()`)
suppresses Nest's own error logging for this, so the failure is a **silent
`process.exit(1)` with no stdout/stderr** — every combined-server-backed
legacy test file fails simultaneously with an opaque `ERR_TEST_FAILURE`, which
looks exactly like a mass regression but is really one bad import in one new
provider. To diagnose: re-run `createApp()` directly (default/true logger) in
a throwaway script outside `node --test`'s TAP wrapper — that surfaces the
real `UnknownDependenciesException`. A `type Foo = A | B` alias used only in
method parameter positions is fine to keep as a type-only import; it's
specifically constructor-parameter types that need the value import.

## Removing a legacy route — the full checklist

Moving a route from `server/src/app.js` to a Nest controller is not just
"write the controller, delete the `app.get`/`app.post` line." Every item below
has caused a real regression at least once:

1. **Keep the legacy helper function alive until every caller has moved**, not
   just the route handler. Grep the *entire* file for the helper's name,
   including anything passed into another mounted sub-module (e.g.
   `organization.js` used to receive `encrypt`/`randomInt` as constructor
   args from `app.js`) — not just within the route block you're editing.
   Deleting a helper that's "apparently unused" broke the whole suite more
   than once (`ReferenceError: encrypt is not defined`) because a sibling
   route elsewhere in the file still called it.
2. **Check whether a blanket legacy middleware covers the route's path
   prefix** (`/api/v1`'s session-auth check, `/api/v1/manager`'s role gate,
   the `["/attendance","/attendance-adjustments","/photos"]` approval gate).
   These keep enforcing their check on every matching request forever, even
   once zero legacy route handlers remain under that prefix — because legacy
   is mounted as Express middleware *ahead of* Nest's router (see
   `server-nest/AGENTS.md`), and middleware runs by registration order
   regardless of which app eventually owns the route. Confirm empirically
   (hit the route as an unauthorized account and see whether you get legacy's
   exact error shape) before writing an equivalent check into the new Nest
   controller — you may need zero new code.
3. **Check whether the route's current public/private status comes from
   registration *order* rather than an explicit check.** `android-download.js`'s
   routes were public only because they were registered in `app.js` *before*
   the session-auth middleware — not because of an allow-list. Deleting the
   mount call without noticing this makes the still-live middleware 401 every
   request to the now-Nest-owned path, since legacy no longer has an earlier
   route to intercept it first. The fix is a `publicAuthPaths` allow-list
   entry (`app.js`, near the top of the session-auth middleware) — add it in
   the same change.
4. After deleting code, grep for zero remaining callers explicitly — don't
   just trust "this looked done." A previous slice left a fully-dead function
   behind for an entire epic before it was caught by grep, not by a test
   failure.

## Testing precedent

- **Raw-SQL/transaction-heavy business services get no `*.service.spec.ts`**:
  `AuthService`, `MeService`, `ShopsService`, `AccountsService`,
  `OrganizationService`, `ReportsService`, `AttendanceService`,
  `AttendanceExportService`, `MailService`, `PhotosService`. These are
  validated by the legacy regression suite instead (see below), which already
  has deep HTTP-level coverage of this logic — a unit spec mocking every
  Prisma call would mostly just restate the implementation.
- **Pure-logic helpers do get a spec**: `ScopeService`, `GeocodeService`,
  `AuditService`, `IdempotencyService`, and small utils
  (`attendance-hours.util.ts`, `attendance-location.util.ts`,
  `photo-storage.util.ts`). Follow whichever precedent your new code matches
  — don't decide ad hoc per module.
- **A legacy `server/test/*.test.js` file that exercises real HTTP routes
  must import `createCombinedTestServer()`** (`src/test-support/combined-app.ts`)
  instead of the bare legacy `app`, once any route it tests has moved to
  Nest. Two files that insert sessions directly via SQL and never call a
  login/register endpoint (`deleted-staff.test.js`, `store-download.test.js`,
  the latter later rewritten for different reasons) are the only ones on the
  bare app by design — not an oversight to "fix" if you see it.
- **Run the legacy suite with `--test-concurrency=1`**, always — its default
  parallelism races test files against the same shared Postgres test
  database. `cd server && TEST_DATABASE_URL=postgresql://pawhub:local_dev_pw_7f3a@127.0.0.1:5432/pawhub_test node --test --test-concurrency=1`
  (relying on `server/.env`'s own `MAIL_ENCRYPTION_KEY` — don't override it
  with an ad hoc value; it must be exactly 64 hex characters or crypto calls
  fail with unrelated-looking errors). `npm test` from the repo root does
  this for you (via `server/package.json`'s own `test` script) except for the
  concurrency flag and `TEST_DATABASE_URL`, which you still need to set.
- A suite result of "N-1/N passing, same failure as always" deserves the same
  suspicion as a flaky test, not a reflexive "unrelated, move on." One root
  cause blocked the back third of `api.test.js` for three straight epics
  (`node --test` aborts the rest of a test function on a thrown assertion, so
  everything after the crash point silently never ran) before someone
  actually read the failing line instead of re-confirming it predated the
  session.

## Scheduled/background work

Register timers via `SchedulerRegistry` + a raw `setInterval(...).unref()`
call in `onApplicationBootstrap()` — not the `@Interval()` decorator. The
legacy regression suite's `createCombinedTestServer()` boots a real app via
`createApp()` but never calls `app.close()`, so a live (non-unref'd) timer
keeps that test's Node process alive forever; `node --test` hangs with no
error message. Registering manually into the same `SchedulerRegistry` an
`@Interval()` job would use means `@nestjs/schedule`'s own shutdown hook still
clears it for free whenever `app.close()` *is* called (the real deployed
process does call it, via `enableShutdownHooks`). See
`src/maintenance/maintenance.scheduler.ts` for the reference implementation.

## Code style (enforced)

`.claude/skills/code-style` has the authoritative hard rules (blank line
between logical blocks inside a function; never inline a raw SQL/Prisma
`$queryRaw`/`$executeRaw` call — wrap it in a named private method; no `any`
anywhere in TypeScript). The last one is now also enforced by
`oxlint`'s `typescript/no-explicit-any: error` — `npm run lint` (from the repo
root or `server-nest/`) runs `oxlint --type-aware` plus a `prettier --check`
formatting check. `.prettierrc`'s `printWidth: 120` matches how this codebase
is actually written (most lines run 90-120 chars; 80 would force a disruptive
rewrap of nearly the whole tree for no real readability gain here) — don't
"fix" it back to the default.

## Swagger / OpenAPI

`server-nest/src/main.ts` serves Swagger UI at `/docs` and the raw document at
`/docs-json`, proxied through nginx at both `deploy/nginx.conf` and
`deploy/nginx.preview.conf` — it's meant to be the frontend integration
contract, so it needs to be opened by someone outside this process to be
useful at all. Request bodies document richly today (Nest's swagger module
introspects the Zod schemas already used for validation) — but **every
response currently has an empty description and no schema**, because every
service method returns loosely-typed `Record<string, unknown>` with nothing
for `@nestjs/swagger` to introspect. When you touch an endpoint, add at least
an `@ApiResponse({ status, description })` with a real description; add a
schema/example too when the shape is simple and stable. Retrofitting full
response schemas across every existing endpoint in one pass was deliberately
not done (it's a from-scratch design exercise for ~55 endpoints, not a
mechanical fix) — do it incrementally as routes get touched, not as a
dedicated sweep.

## Deviations from the obvious default — don't re-litigate these

| Obvious default | What this project actually does | Why |
|---|---|---|
| `nestjs-zod` for Zod validation | Nest's native `StandardSchemaValidationPipe` | Nest 12's `@nestjs/common` already works directly with Zod 4.2+; the third-party package is unnecessary |
| `eslint` + `prettier` | `oxlint` + `prettier` | Scaffold choice (Epic 1) — oxlint is faster and already enforces the project's TS rules; "for TS" in any task mentioning eslint means this codebase's only TS workspace, `server-nest/` |
| `@nestjs/authentication` / `@nestjs/authorization` | Hand-written `SessionAuthGuard`/`RolesGuard` + `@Roles()`/`@CurrentAccount()` | The legacy token scheme (opaque random token, sha256-hashed, stored in a `sessions` table with specific ACTIVE/WORKER-pending-approval eligibility SQL) is a fixed format the regression suite depends on byte-for-byte; adopting the first-party packages' session/JWT model risked subtle behavioral drift |
| prettier's default `printWidth: 80` | `printWidth: 120` | Matches how the codebase has actually been written throughout every prior epic; changing it to 80 would force a one-time disruptive rewrap of nearly every file |
| Docker/a `Dockerfile` for deployment | systemd (`deploy/pawhub.service`) + a docker-compose preview env with no Dockerfile of its own | Pre-existing infra choice from before the NestJS migration; no Dockerfile exists anywhere in this repo and Epic 6 didn't introduce one |
