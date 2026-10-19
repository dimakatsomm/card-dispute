# 10 — Functional Architecture (TypeScript)

Owner decision 2026-10-19 (ADR-036): all code — backend, Lambdas, frontend — follows a **functional**
architecture, not a class-based one. This doc is the contract every implementer follows; lint enforces the
mechanical parts.

---

## 1. Shape: functional core, imperative shell

```
┌──────────────────────── shell (effects) ────────────────────────┐
│ Fastify route / Lambda handler / React component                  │
│   parse input (zod) → call use-case → map Result → respond        │
│                                                                   │
│   ┌────────────── use-cases (orchestration) ──────────────┐       │
│   │ (deps) => async (input) => Result                      │       │
│   │ fetch data through deps · call core · persist via deps │       │
│   │                                                        │       │
│   │   ┌──────── core (pure) ────────┐                      │       │
│   │   │ data in → data out           │                      │       │
│   │   │ no I/O, no clock, no throws  │                      │       │
│   │   └──────────────────────────────┘                      │       │
│   └────────────────────────────────────────────────────────┘       │
│ adapters: db, http clients, S3 signer, SQS publisher, clock        │
└───────────────────────────────────────────────────────────────────┘
```

| Layer | Lives in | Rules |
|---|---|---|
| **Core** | `backend/packages/dispute-domain`, `backend/<svc>/src/core/` | Pure functions over immutable data. No I/O, no `Date.now()`, no `Math.random()`, no exceptions for business outcomes. 100% testable with zero mocks. |
| **Use-cases** | `backend/<svc>/src/use-cases/` | Curried `(deps) => (input) => Promise<Result>`. They orchestrate: read through deps, call core, write through deps. Hold no state. |
| **Adapters** | `backend/<svc>/src/adapters/` | Factory functions returning records of functions (`createDisputeRepo(pool)` → `{ findByTransaction, insert, … }`). These wrap the libraries (pg, AWS SDK, fetch). The only place third-party APIs are touched. |
| **Shell** | `backend/<svc>/src/routes/`, Lambda `handler.ts`, `main.ts` | Thin: zod-parse → use-case → `Result` → HTTP/problem+json. `main.ts` is the **composition root**: it builds the adapters and wires them into the use-cases once. |

---

## 2. Rules

1. **No `class` declarations or expressions** in our code, including custom `Error` subclasses.
   Using library classes is allowed only inside adapters (`new S3Client()`, `new GetObjectCommand()`, testcontainers).
2. **Data is plain and immutable.**
   - `type` aliases (not interfaces with methods) and `readonly` fields.
   - `ReadonlyArray`, and `as const` for literal tables.
   - Never mutate an argument; return a new value.
3. **Model states as discriminated unions**, never as flags plus optional fields. Example:
   `type Eligibility = { allowed: true } | { allowed: false; reason: EligibilityReason }`.
4. **Expected failures are values, not exceptions.** Core and use-cases return `Result<T, E>`, where `E` is a
   union of error codes. `throw` is only for programmer errors and infrastructure faults; the shell maps
   those to 500/503.
5. **Dependencies are passed in, never imported as singletons.** No module-level mutable state.
   - Clock: `now: () => Date` in deps.
   - IDs: `newId: () => string` in deps (the DB defaults `uuidv7()` where it can).
6. **Small, total functions.** Make illegal states unrepresentable, prefer exhaustive `switch` with an
   `assertNever` default, and avoid `any` (use `unknown` + zod at the edges).
7. **Composition over inheritance.** Reuse comes from higher-order functions and plain function
   composition (`pipe`), never base classes or mixins.
8. **React: function components + hooks only.**
   - Server state via a query hook (e.g. TanStack Query — version to verify) wrapping the generated client functions.
   - Derived UI state computed, not stored.
9. **Testing follows the layers.**
   - Core: table-driven tests, no mocks.
   - Use-cases: inject **plain fake objects** (`{ findByTransaction: async () => … }`), not mocking frameworks
     or class spies.
   - Adapters: integration tests (testcontainers / moto).
   - Shell: HTTP tests through Fastify `inject`.

---

## 2a. Comments (ADR-045)
- Default: **no comment**. Clear names, small functions and types carry the meaning.
- Write one only for a non-obvious *why*: a library quirk, a security reason, a deliberate trade-off. Keep it to **one line**, linking an ADR or issue if longer context exists.
- Never: restating what the code does, file/section banners, commented-out code, TODOs without an issue id, JSDoc on internal functions. Public package entry points may have a one-line summary.
- Reviewers treat verbose or redundant comments as a finding.

## 3. Shared primitives — `backend/packages/shared/fp`

Kept deliberately small; no FP framework dependency (e.g. no fp-ts/Effect) at this stage.

```ts
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const map = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

export const flatMap = <T, U, E, F>(r: Result<T, E>, f: (t: T) => Result<U, F>): Result<U, E | F> =>
  r.ok ? f(r.value) : r;

export const assertNever = (x: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
};
```

---

## 4. Worked example — create dispute

**Core** (`@cd/dispute-domain`, pure):
```ts
export type EligibilityReason =
  | 'ALREADY_DISPUTED' | 'CARD_EXPIRED' | 'TXN_NOT_POSTED' | 'TXN_TYPE_NOT_DISPUTABLE' | 'OUTSIDE_WINDOW';

export const evaluateTransactionEligibility = (
  txn: Transaction, card: Card, existing: DisputeRef | null, now: Date,
): Result<true, EligibilityReason> => {
  if (existing) return err('ALREADY_DISPUTED');
  if (isCardExpired(card, now)) return err('CARD_EXPIRED');
  if (txn.status !== 'POSTED') return err('TXN_NOT_POSTED');
  if (txn.type === 'REFUND') return err('TXN_TYPE_NOT_DISPUTABLE');
  if (daysBetween(txn.postedAt!, now) > DISPUTE_WINDOW_DAYS) return err('OUTSIDE_WINDOW');
  return ok(true);
};
```

**Use-case** (`backend/disputes/src/use-cases/create-dispute.ts`):
```ts
export type CreateDisputeDeps = {
  readonly fetchTransaction: (userId: string, txnId: string) => Promise<Transaction | null>;
  readonly fetchCard: (userId: string, cardId: string) => Promise<Card | null>;
  readonly disputes: Pick<DisputeRepo, 'findByTransaction' | 'insertWithEvidence'>;
  readonly signUploads: (decls: ReadonlyArray<EvidenceDeclaration>, disputeId: string) => Promise<ReadonlyArray<UploadInstruction>>;
  readonly publish: (event: DisputeEvent) => Promise<void>;   // best-effort, never throws
  readonly now: () => Date;
};

export type CreateDisputeError = 'NOT_FOUND' | EligibilityReason | InputError;

export const createDispute = (deps: CreateDisputeDeps) =>
  async (input: CreateDisputeInput): Promise<Result<CreatedDispute, CreateDisputeError>> => {
    const valid = validateDisputeInput(input);
    if (!valid.ok) return valid;

    const txn = await deps.fetchTransaction(input.userId, input.transactionId);
    if (!txn) return err('NOT_FOUND');
    const card = await deps.fetchCard(input.userId, txn.cardId);
    if (!card) return err('NOT_FOUND');

    const eligible = evaluateTransactionEligibility(
      txn, card, await deps.disputes.findByTransaction(txn.transactionId), deps.now());
    if (!eligible.ok) return eligible;

    const created = await deps.disputes.insertWithEvidence(input);    // unique-violation → err('ALREADY_DISPUTED')
    if (!created.ok) return created;

    const uploads = await deps.signUploads(input.evidence, created.value.disputeId);
    await deps.publish({ type: 'DisputeCreated', disputeId: created.value.disputeId, userId: input.userId });
    return ok({ ...created.value, uploads });
  };
```

**Shell** (`backend/disputes/src/routes/public.ts`):
```ts
export const publicRoutes = (uc: UseCases): FastifyPluginAsync => async (app) => {
  app.post('/dispute/:transactionId', async (req, reply) => {
    const body = CreateDisputeBody.parse(req.body);                       // 400 on failure (shared error hook)
    const result = await uc.createDispute({ ...body, userId: req.principal.userId,
                                            transactionId: req.params.transactionId });
    return result.ok
      ? reply.code(201).header('etag', `"${result.value.version}"`).send(result.value)
      : sendProblem(reply, toProblem(result.error));                       // exhaustive switch → 404/409/422
  });
};
```

**Composition root** (`backend/disputes/src/main.ts`): build the pg pool, HTTP clients and S3 signer once → adapters → `createDispute(deps)` → register routes on the public / service Fastify instances.

**Test** (no mocking library):
```ts
const deps: CreateDisputeDeps = {
  fetchTransaction: async () => postedTxn,
  fetchCard: async () => expiredCard,
  disputes: { findByTransaction: async () => null, insertWithEvidence: async () => { throw new Error('must not be called'); } },
  signUploads: async () => [], publish: async () => {}, now: () => new Date('2026-10-19T00:00:00Z'),
};
expect(await createDispute(deps)(input)).toEqual(err('CARD_EXPIRED'));
```

---

## 5. Service folder layout (each `backend/<svc>/`)

```
src/
  core/            pure functions + types specific to this service (shared rules stay in dispute-domain)
  use-cases/       one file per use-case: (deps) => (input) => Promise<Result>
  adapters/        createXxxRepo(pool), createXxxClient(fetch, tokenProvider), createS3Signer(client) …
  routes/          public.ts (8080), service.ts (8081): zod parse → use-case → response
  errors.ts        error-code → problem+json mapping (exhaustive)
  main.ts          composition root (the only place that knows every concrete adapter)
test/
  core/  use-cases/  adapters/ (integration)  routes/ (Fastify inject)
```

Lambdas use the same split: `handler.ts` (shell, parses the event) → `use-cases/` → `adapters/`.

---

## 6. Enforcement (lint, in F-01)

- `no-restricted-syntax`: **ban `ClassDeclaration` and `ClassExpression`** everywhere in `backend/` and
  `frontend/`. ⚠ Check for libraries that force subclassing; none are planned.
- `no-param-reassign` (props too), `prefer-const`, `@typescript-eslint/prefer-readonly-parameter-types` (warn), `no-restricted-globals` for `Date.now` inside `core/` and `dispute-domain`.
- Import boundaries:
  - `core/` may import only `core/`, `@cd/dispute-domain` and `@cd/shared/fp`.
  - `use-cases/` may not import `adapters/`; it gets them via deps.
  - Only `main.ts` imports concrete adapters.
- Optional, to evaluate: `eslint-plugin-functional` (immutable-data, no-this-expression). Verify its current version and ESLint 9 flat-config support before adopting.
- Code-standards-reviewer checks the parts lint can't: Result usage, no hidden singletons, exhaustive error mapping.

---

## 7. Test discipline — useful tests only (ADR-040, owner 2026-10-19)

A test earns its place only if it would **fail for a defect a user, an attacker or an operator would actually hit**.

**Write**
- One test per acceptance criterion. Name it after the criterion.
- One test per real risk: ownership (user B → 404), invalid state transitions, money/date boundaries
  (120/121 days, month-end card expiry), concurrency (two writers on one version, duplicate POST), and security
  controls (scope checks, evidence validation).
- Core rules as **one table-driven test per function**: rows, not copies.
- Use-cases with plain fakes for their decision paths. Adapters with one integration test per query/command.

**Don't write**
- Tests of library/framework behaviour (Fastify routing, zod parsing, the AWS SDK, React rendering).
- Tests the compiler already proves (types, exhaustiveness), or trivial mappers/getters.
- The same auth/token case repeated on every endpoint. Prove it once in `auth-client`/`auth`, plus one guard test per port.
- Snapshot tests. Tests asserting log lines (except PII-redaction, once).
- Coverage-% targets. Coverage is a diagnostic: read it to find untested *risk*, never to hit a number.

**Shape**
- Prefer a few tests through the use-case or the route over many tests of internals.
- E2E/UI suites cover the **flows** in the milestone outcome, not every edge (edges belong lower down).
- A flaky test is fixed or deleted the same day; it never gets retried into green.

The test-engineer and code-standards-reviewer reject a task for **missing** risk coverage *and* for **padding**
(tests that can't fail for a real defect).
