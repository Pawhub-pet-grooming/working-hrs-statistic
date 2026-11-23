---
name: code-style
description: Project-specific code style conventions for this repository, beyond what the linter enforces. Use whenever writing or editing source code (server/, server-nest/, web/) in this project.
license: MIT
---

# Code style conventions

Rules specific to this project. Follow these in addition to whatever a linter or formatter already enforces.

## 1. Separate logical blocks inside a function with a blank line (HARD rule)

Inside a function body, put a blank line between logical blocks/steps. Never write a function body as one dense, unbroken block of statements. This is a hard rule — always apply it, not a style preference to weigh against other concerns.

Wrong:

```typescript
function placeOrder(cart: Cart): Order {
  const items = cart.items.filter((item) => item.quantity > 0);
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return { items, total };
}
```

Right:

```typescript
function placeOrder(cart: Cart): Order {
  const items = cart.items.filter((item) => item.quantity > 0);

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  return { items, total };
}
```

A "logical block" is a group of statements doing one coherent step (e.g. validating input, computing a value, calling a dependency, building the return value). A single statement that stands on its own as a distinct step still gets blank lines around it, as in the example above.

## 2. Never write SQL directly inside a method — wrap it in a private method (HARD rule)

Do not embed a raw SQL query (`pool.query(...)`, `this.db.$queryRaw`/`$executeRaw`, or any other raw-SQL escape hatch) inline inside a method's body. Extract the query into its own private method, named for what it does, and call that method instead. This is a hard rule — always apply it, not a style preference to weigh against other concerns.

Wrong:

```typescript
async findActiveWorkers(shopId: string): Promise<Worker[]> {
  const rows = await this.db.$queryRaw`SELECT * FROM workers WHERE shop_id = ${shopId} AND status = 'ACTIVE'`;

  return rows.map(mapWorker);
}
```

Right:

```typescript
async findActiveWorkers(shopId: string): Promise<Worker[]> {
  const rows = await this.queryActiveWorkersByShop(shopId);

  return rows.map(mapWorker);
}

private async queryActiveWorkersByShop(shopId: string) {
  return this.db.$queryRaw`SELECT * FROM workers WHERE shop_id = ${shopId} AND status = 'ACTIVE'`;
}
```

This keeps business-logic methods free of embedded SQL, and gives every query a name that documents what it does. Applies equally to the legacy `server/` code (raw `pg` queries) and `server-nest/` (Prisma raw queries) — ordinary Prisma Client calls (`this.db.worker.findMany(...)`) aren't raw SQL and aren't required to be wrapped by this rule.

**Security note:** the wrapped query must still be injection-safe. `this.db.$queryRaw` used as a tagged template literal (backticks right after `$queryRaw`, as above) is safe — Prisma binds each interpolated value as a parameter, it never concatenates it into the SQL string. Do not "simplify" this into `$queryRawUnsafe(...)`, or into building the SQL as a string first and passing that in — both lose the automatic parameterization and reopen SQL injection. The same applies to legacy `server/`'s raw `pg.Pool.query(...)`: interpolate nothing into the query string; always pass values through its `$1, $2, ...` placeholders and a separate params array.

## 3. No `any` type in TypeScript (HARD rule)

Never use `any` in TypeScript code (`server-nest/`, `web/`) — not as a variable/parameter/return type, not as a generic argument, and not via an `as any` cast. This is a hard rule — always apply it, not a style preference to weigh against other concerns. Legacy `server/` is plain JS and has no TypeScript types to violate this rule with.

Wrong:

```typescript
function parseWebhookPayload(body: any): WebhookEvent {
  return { type: body.type, data: body.data };
}
```

Right:

```typescript
function parseWebhookPayload(body: unknown): WebhookEvent {
  const parsed = webhookPayloadSchema.parse(body);

  return { type: parsed.type, data: parsed.data };
}
```

Use `unknown` plus a type guard or schema validation (e.g. Zod's `.parse()`) when the shape genuinely isn't known in advance; use a generic (`function wrap<T>(value: T): Box<T>`) when the type varies but is still tracked; use the real type from the library when one exists. The one narrow exception is an ambient `declare module '...'` for an external, untyped plain-JS import (e.g. `src/legacy-app.d.ts`) — that marks a module boundary, not an `any` written into our own logic.
