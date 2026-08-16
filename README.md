# @nivinjoseph/n-data

A comprehensive data access library for Node.js applications, built on top of Knex.js with PostgreSQL support. This library provides a robust set of tools for database operations, caching, file storage, and distributed locking.

## Features

- **Database Operations**
  - PostgreSQL database access with Knex.js
  - Read and write database operations
  - Unit of Work pattern implementation
  - Database migrations
  - Connection management
  - Event sourcing repositories, with JSONB expression indexes for querying snapshots

- **Caching**
  - In-memory caching
  - Redis-based caching
  - Cache service abstraction

- **File Storage**
  - S3 file storage integration
  - File metadata management
  - Secure file handling

- **Distributed Systems**
  - Distributed locking mechanism
  - Redis-based distributed locks
  - Lock management and configuration

## Installation

```bash
npm install @nivinjoseph/n-data

or 

yarn add @nivinjoseph/n-data
```

## Requirements

- Node.js >= 24.10
- PostgreSQL database
- Redis (for distributed locking and caching features)

## Usage

### Database Operations

```typescript
import { KnexPgDb, DbConnectionConfig, KnexPgDbConnectionFactory } from '@nivinjoseph/n-data';

// Configure database connection
// Every field is a string, including port
const config: DbConnectionConfig = {
    host: 'localhost',
    port: '5432',
    database: 'mydb',
    username: 'postgres',
    password: 'password'
};

// Create database connection factory
const connectionFactory = new KnexPgDbConnectionFactory(config);

// Create database instance
const db = new KnexPgDb(connectionFactory);

// Execute queries with type safety
const result = await db.executeQuery<{id: number; name: string; age: number;}>('SELECT * FROM users WHERE id = ?', 1);

// Execute commands
await db.executeCommand('INSERT INTO users (name, age) VALUES (?, ?)', 'John', 30);
await db.executeCommand('UPDATE users SET age = ? WHERE name = ?', 31, 'John');
await db.executeCommand('DELETE FROM users WHERE name = ?', 'John');
```

### Dependency Injection

The implementation classes carry `@inject` decorators, so they resolve only if you register
their dependencies under the exact keys they ask for. The keys are not configurable:

| Class | Injects |
| --- | --- |
| `KnexPgReadDb` | `"ReadDbConnectionFactory"` |
| `KnexPgDb` | `"DbConnectionFactory"` |
| `KnexPgUnitOfWork` | `"DbConnectionFactory"` |
| `RedisCacheService` | `"CacheRedisClient"` |
| `RedisDistributedLockService` | `"RedisClient"` |
| `DbMigrationScriptRunner` | `"Logger"` |

Two of these are easy to get backwards. `KnexPgDb` extends `KnexPgReadDb`, but the two take
**different** keys — register both factories if you use both classes. And the two Redis
consumers take **different** keys for the same client type: `"CacheRedisClient"` for caching,
`"RedisClient"` for locking.

```typescript
registry
    .registerInstance("Logger", logger)
    .registerInstance("DbConnectionFactory", new KnexPgDbConnectionFactory(dbConfig))
    .registerSingleton("Db", KnexPgDb)
    .registerTransient("UnitOfWork", KnexPgUnitOfWork);
```

**The lifetimes are load-bearing**, and getting one wrong produces a runtime error that names
neither the cause nor the fix:

- **`Db` is a singleton** — it wraps the connection pool, which is meant to be shared.
- **`UnitOfWork` is transient.** It is single-use by construction: it holds one transaction,
  and once committed or rolled back *every* method on it throws. A singleton would hand a dead
  transaction to the second caller and accumulate commit callbacks across unrelated operations.
- **Repositories are scoped**, so each scope resolves its own repository over its own unit of work.

The consequence is that **a scope is a write boundary, not just a resolution boundary.** A scoped
repository holds exactly one unit of work, and `save` with no explicit unit of work commits it. A
committed unit of work is dead, so **a second `save` in the same scope fails** from inside the
repository with `rolling back completed UnitOfWork`.

One scope per operation is therefore the model — which a web application gets for free by scoping
per request. Two writes that must share a transaction take an explicit unit of work instead, via
`saveWithin`. See `test-example/common/ioc/common-installer.ts` for a complete installer and
`test-example/test/example.test.ts` for the scoping pattern.

### Unit of Work

```typescript
import { UnitOfWork, KnexPgUnitOfWork } from '@nivinjoseph/n-data';

// Create unit of work
const unitOfWork = new KnexPgUnitOfWork(connectionFactory);

// Register callbacks for commit and rollback
unitOfWork.onCommit(async () => {
    console.log('Transaction committed successfully');
});

unitOfWork.onRollback(async () => {
    console.log('Transaction rolled back');
});

try {
    // Execute commands within the transaction
    await db.executeCommandWithinUnitOfWork(unitOfWork, 
        'INSERT INTO products(id, name) VALUES(?, ?)', 
        1, "milk");
    
    await db.executeCommandWithinUnitOfWork(unitOfWork,
        'INSERT INTO products(id, name) VALUES(?, ?)',
        2, "pasta");
    
    // Commit if all operations succeed
    await unitOfWork.commit();
} catch (error) {
    // Rollback if any operation fails
    await unitOfWork.rollback();
}
```

### Event Sourcing Repositories

Aggregates are stored as an append-only event stream plus a snapshot of the current state. Reads by id are served by the snapshot table's primary key. To query a field *inside* the snapshot's `data` column, declare it on a `SnapshotQuerySet` — `DbTableCreator` builds a btree expression index over the extraction expression, without adding a column to the table.

An **array** inside `data` takes the other kind: `withArrayPath` builds a GIN index over the array as jsonb and answers containment — "does some element look like this" — which is how a membership query is served. It is a whole predicate rather than an expression, because for GIN the *operator* is part of what makes the index usable.

**One `SnapshotQuerySet` per repository is the whole declaration.** The migration creates the table's indexes from it and the repository builds its predicates from it, so a queried index is necessarily a created one — and every path and value in a query is checked against that declaration at compile time.

```typescript
import { SnapshotBaseRepository, SnapshotQuerySet, JsonValueType } from '@nivinjoseph/n-data';
import { inject } from '@nivinjoseph/n-ject';

// 1. Declare what is queryable, once
@inject("OrderEventStreamRepository")
export class OrderRepository extends SnapshotBaseRepository<Order, OrderState, OrderEvent>
{
    // paths are checked against OrderState, so a typo is a compile error
    public static readonly indexes = SnapshotQuerySet.for<OrderState>()
        .withPath("status")
        .withPath("total", { type: JsonValueType.numeric })
        .withPath("customer.city")                                       // nested key
        .withPath("orderNumber", { unique: true })                       // a natural key
        .withComposite(["tenantCode", "sku"], { unique: true })          // a composite one
        .withArrayPath("tags");

    // required by the base, which declares it abstract at the declaration-only DeclaredSnapshotQuerySet
    // type — forgetting it is a compile error, and the `typeof` is what carries the narrow, queryable
    // type to the call sites
    protected override get querySet(): typeof OrderRepository.indexes { return OrderRepository.indexes; }

    public constructor(eventStreamRepository: OrderEventStreamRepository)
    {
        super(eventStreamRepository);
    }

    // `query` owns the statement — `select data from <table> where (<predicate>)` — so what you
    // pass is a predicate built from the set above.
    public getByStatus(status: string): Promise<Array<Order>>
    {
        return this.query(this.querySet.eq("status", status));
    }

    // a number, because `total` declared a numeric cast. Without one this would not compile —
    // uncast, the extraction compares as text and '9' > '100'.
    public getOverTotal(total: number): Promise<Array<Order>>
    {
        return this.query(this.querySet.gt("total", total));
    }

    public getByTag(tag: string): Promise<Array<Order>>
    {
        return this.query(this.querySet.contains("tags", tag));
    }

    // predicates compose, and every combinator parenthesizes its result
    public getRushIn(city: string, statuses: ReadonlyArray<string>): Promise<Array<Order>>
    {
        return this.query(this.querySet.and(
            this.querySet.eq("customer.city", city),
            this.querySet.in("status", statuses)));
    }

    // Ordering and paging go on the object form, which also takes no predicate at all
    public getLargestOrders(count: number): Promise<Array<Order>>
    {
        return this.query({ orderBy: this.querySet.orderBy("total", "desc"), limit: count });
    }

    // A projection that does not map onto the aggregate goes through queryRaw,
    // which performs no deserialization. `expressionFor` hands back the indexed expression.
    public async getCountByStatus(): Promise<ReadonlyArray<{ status: string; count: number; }>>
    {
        const result = await this.queryRaw<{ status: string; count: number; }>(
            `select ${this.querySet.expressionFor("status")} as status, cast(count(*) as int) as count
             from ${this.table} group by 1;`);

        return result.rows;
    }
}
```

The paths a query can name are exactly the ones declared above — not merely the ones that exist on `OrderState`:

```typescript
this.querySet.eq("status", "sent");        // ok
this.querySet.eq("placedAt", "2024-01");   // error: on OrderState, but never declared here
this.querySet.eq("total", "100");          // error: total is a number
this.querySet.eq("nope", "x");             // error: not a path on OrderState
this.querySet.contains("status", "sent");  // error: status is not an array path
```

```typescript
import { DbMigration, DbTableCreator, Db } from '@nivinjoseph/n-data';
import { Logger } from '@nivinjoseph/n-log';

// 2. The migration creates the tables from that same object
@inject("Db", "Logger")
export class AddOrderTables_1 implements DbMigration
{
    private readonly _db: Db;
    private readonly _logger: Logger;

    public constructor(db: Db, logger: Logger)
    {
        this._db = db;
        this._logger = logger;
    }

    public async execute(): Promise<void>
    {
        const tableCreator = new DbTableCreator(this._db, this._logger);

        await tableCreator.createEventStreamTableForAggregate(Order);
        await tableCreator.createSnapshotTableForAggregate(Order, OrderRepository.indexes);

        // -> create index ... on order_snaps((data->>'status'));
        //    create index ... on order_snaps(((data->>'total')::numeric));
        //    create index ... on order_snaps((data#>>'{"customer","city"}'));
        //    create unique index ... on order_snaps((data->>'orderNumber'));
        //    create unique index ... on order_snaps((data->>'tenantCode'), (data->>'sku'));
        //    create index ... on order_snaps using gin((data->'tags') jsonb_path_ops);
    }
}
```

Arrays are the other kind. The motivating shape is a membership query with more than one condition — *given a `userId`, find the teams where that user is a member **and** that member is not deactivated*:

```typescript
interface Member { userId: string; role: string; isDeactivated: boolean; }
interface TeamState extends AggregateState { members: Array<Member>; }

@inject("TeamEventStreamRepository")
export class TeamRepository extends SnapshotBaseRepository<Team, TeamState, TeamEvent>
{
    public static readonly indexes = SnapshotQuerySet.for<TeamState>().withArrayPath("members");

    protected override get querySet(): typeof TeamRepository.indexes { return TeamRepository.indexes; }

    public constructor(eventStreamRepository: TeamEventStreamRepository)
    {
        super(eventStreamRepository);
    }

    public getActiveTeamsForUser(userId: string): Promise<Array<Team>>
    {
        // ONE containment document, so both fields must hold on the SAME member element.
        // `{ userld }` or `{ isDeactivated: "false" }` would be compile errors — the element
        // type is resolved from the path literal.
        return this.query(this.querySet.contains("members", { userId, isDeactivated: false }));
    }
}

// in the migration
await tableCreator.createSnapshotTableForAggregate(Team, TeamRepository.indexes);

// -> create index ... on team_snaps using gin((data->'members') jsonb_path_ops);
//
//    select data from team_snaps where (((data->'members') @> cast(? as jsonb)));
//    -- param: '[{"userId":"u1","isDeactivated":false}]'
//    -- the fragment parenthesizes itself and `query` parenthesizes the predicate; both are
//    -- there so a fragment stays contained wherever it is spliced
```

`createSnapshotTableForAggregate` takes a `SnapshotQuerySet`, or an options object carrying both kinds — `{ indexes, arrayIndexes }`. A set satisfies the options shape by construction, since `indexes` and `arrayIndexes` are exactly its two getters. Omit the argument for a table with no indexes.

Both fields are required, and the bare index array that used to be accepted is gone. That form had nowhere to put array indexes, so `createSnapshotTableForAggregate(Order, OrderRepository.indexes.indexes)` compiled, created every btree index, silently omitted every GIN one, and left `contains` sequential-scanning with nothing failing at migration time. Declaring btree indexes and no array ones is still legal — it is spelt `arrayIndexes: []`, which says so.

Every create method has a `verify` counterpart taking the same arguments — `verifySnapshotTableForAggregate(Order, OrderRepository.indexes)` — which touches nothing and returns every divergence between the declaration and the database as `SnapshotDriftIssue`s. Creation is `if not exists` and migrations never re-run, so a declaration changed *after* its migration ran drifts silently; the verify call is the detector. Run it at the tail of a migration run and throw on any `fatal` issue, or assert it empty in an integration test — see the "Verify the database against the declaration" bullet below for the full issue catalogue.

`SnapshotIndex` and `SnapshotArrayIndex` remain public underneath, for the path a typed signature cannot name — a computed key, a whole subtree — through their `forRawPath` doors. (Not a `$`-prefixed name: the segment validation rejects `$` through every door; see the `$typename` notes below.) Pass such a declaration alongside a set's own.

If a migration should not import a repository, put the set in a module both import — the point is that one declaration is the source of both the index and the predicate, not where it lives.

The stored document itself has a type: `SnapshotDocumentOf<TState>` is what `AggregateRoot.snapshot()` actually returns — the state's own keys (no top-level `$typename`), each value as n-domain's `SerializedValue` renders it: a `DomainObject` member as its serialized record (`$typename` included), a `Date` as the string it stores, plain objects JSON-cloned. `toSnapshotDocument(aggregate)` is the one sanctioned door from an aggregate to that shape — upstream types `snapshot()` as `TState | object`, and this is where that union is asserted, once. The repositories use it on every save, and it is what `verifyDocument` takes:

```typescript
import { SnapshotDocumentOf, toSnapshotDocument } from '@nivinjoseph/n-data';

// in a test: every declared path resolves inside a real snapshot document, no casts
assert.deepStrictEqual(OrderRepository.indexes.verifyDocument(toSnapshotDocument(order)), []);
```

One runtime door the type cannot see: `snapshot(...cloneKeys)` JSON-clones the named keys instead of serializing them. The repositories never pass `cloneKeys`, and the type assumes none.

```typescript
import { OrgSnapshotBaseRepository, SnapshotQuerySet } from '@nivinjoseph/n-data';

// 3. Organization-scoped aggregates: `query` adds the organization filter itself
@inject("InvoiceEventStreamRepository")
export class InvoiceRepository extends OrgSnapshotBaseRepository<Invoice, InvoiceState, InvoiceEvent>
{
    public static readonly indexes = SnapshotQuerySet.for<InvoiceState>().withPath("status");

    protected override get querySet(): typeof InvoiceRepository.indexes { return InvoiceRepository.indexes; }

    public constructor(eventStreamRepository: InvoiceEventStreamRepository)
    {
        super(eventStreamRepository);
    }

    public getByStatus(status: string): Promise<Array<Invoice>>
    {
        // identical to the plain variant above — `organization_id = ?` is prepended for you,
        // ahead of this predicate, which is both the isolation and the leading index column
        return this.query(this.querySet.eq("status", status));
    }

    // -> select data from invoice_snaps
    //    where organization_id = ? and (((data->>'status') = ?));
}
```

A read that is genuinely meant to span tenants — and only that — goes through `queryAcrossOrganizations`, which takes a whole statement and adds nothing to it. It is named for its consequence so the tenant implication is visible at the call site. On the plain snapshot repository the same escape hatch is called `queryStatement`, since there is no tenant scope to step outside of; it is there for the joins, unions and CTEs the built statement cannot express.

Both belong to the **snapshot** repositories only. An event stream repository reads by aggregate id or in full and offers no query surface at all — see below.

Things to get right:

- **Type the `querySet` override as `typeof MyRepository.indexes`.** This used to be the single highest-cost mistake available in this API: the base declared the getter as `SnapshotQuerySet<TState, any, any>`, so writing that same widened type in the override compiled and silently discarded path and cast checking. Both spellings of the mistake are compile errors now — the base declares the method-free `DeclaredSnapshotQuerySet<TState>`, so copying the base's type yields an object that cannot build a single predicate (no `eq`, no `contains` — the mistake announces itself at the first query), and the widened spelling trips a phantom brand whose error message names the fix. Return the set through `typeof`, as every example here does, and the declared paths flow into the type.
- **Every expression comes from a declaration.** Postgres only uses an expression index when the query expression matches the indexed one *textually*. A near-miss — `data->>'total'` against an index on `((data->>'total')::numeric)` — silently falls back to a sequential scan, with no error and no warning. The expression *builder* is private to `SnapshotIndex`, so an expression can only originate from a declaration that also emits the DDL, and the set hands back the exact string its index was created from. A planner test proves the match, and proves the near-miss above does not.
- **A query can only name a path the set declared.** Not merely one that exists on the state: `TIndexed` is the record of declared paths, so `eq("placedAt", …)` on an undeclared path is a compile error, and so is `orderBy` or `expressionFor` on one. That is what closes the gap the older pattern left open, where an index could be declared, queried, and never actually created.
- **A numeric path needs a cast to be compared as a number — or ordered as one.** `withPath("total", { type: JsonValueType.numeric })` is what makes `gt("total", 100)` and `orderBy("total", "desc")` compile; declared without one, both calls are rejected, because an uncast extraction compares and sorts as text and `'9' > '100'`. Text needs no cast (Postgres elides a redundant `::text`), and a boolean compares correctly as `'true'`/`'false'` for equality and orders as boolean. The cast is also checked *against the leaf*: a numeric cast on a string leaf — which would compile the declaration and then fail every insert at the index expression — is a compile error, as is `uuid` on a number or anything non-`boolean` on a boolean.
- **Matching the expression is necessary but not sufficient.** A btree index only serves a predicate that constrains a *leading prefix* of its columns, so the second path of a composite — or any path on an org table, since those indexes lead with `organization_id` — is not independently searchable however exactly the expression matches. Read `info.createdIndexes` from the create call for each index's grouping, column order and `leadingColumn`. Both halves are verified against Postgres by planner tests, not just asserted here.
- **`organizationId` is not an indexable path.** An org-scoped state declares it, but on the table it is a real column, and every index leads with it — so constraining the column does use those indexes, while the copy inside `data` is not what any index covers. `forPath("organizationId")` is therefore a compile error. The exclusion is unconditional, so a *plain* aggregate that legitimately keeps a top-level `organizationId` in `data` reaches it through `forRawPath`.
- **A prefix `LIKE` does not use the index** unless the database collation is `C`. The default text opclass serves `=`, ranges and `order by`, but `like 'abc%'` sequential-scans past a perfectly good index on a typical `en_US.utf8` database. `text_pattern_ops` is the fix and this API does not express opclasses — build that index by hand in a migration if a prefix search has to be fast.
- **`unique` compares the extracted text exactly.** Nothing is folded or trimmed, so a "unique email" index accepts `a@x.com`, `A@x.com` and `" a@x.com "` as three distinct values. There is no `lower()` option on purpose — every extra expression form is another spelling the read side must match. Normalize in the domain, before the value reaches the snapshot.
- **Only leaf scalars are `SnapshotIndex`-able.** A container key (`"customer"`, `"members"`) is a compile error, because indexing one covers jsonb's own text rendering of the subtree — which orders keys itself, so a predicate built with `JSON.stringify` would never match. Reach the leaf (`"customer.city"`), take an *array* key to `SnapshotArrayIndex` instead, or use `forRawPath` if you really want the subtree. The two path unions are disjoint by construction, so a key belongs to exactly one kind of index — and declaring one path as both is rejected.
- **Index bounded values only.** A btree index tuple must fit 2704 bytes *after compression*, checked on insert rather than at create time — so a repetitive 4KB value indexes fine while an incompressible one of the same length permanently fails `save`. Index codes, enums, ids, numbers and timestamps, not free text.
- **Pass a `type` whenever the value is not a string**, and leave it off when it is — extraction already yields `text`, and Postgres *elides* a redundant `::text`, so an index built with `JsonValueType.text` is byte-for-byte the same index as one built without it and their predicates are interchangeable. It is the one case where two different expression strings are equivalent. An uncast comparison sorts lexicographically, making `'9' > '100'` true, so this is a correctness concern and not just a performance one. Each path carries its own cast, so a composite can mix types. `JsonValueType` has no date/time members, because those parse through non-immutable functions that Postgres rejects in an index expression — store a timestamp as epoch millis and use `JsonValueType.bigint`, or as an ISO-8601 string and leave it as text, which sorts chronologically anyway.
- **Uniqueness covers the whole index.** One path constrains that value; several constrain the tuple, so `withComposite(["tenantCode", "sku"], { unique: true })` allows a repeated `tenantCode` as long as the pair differs. Rows whose `data` omits an indexed key are unconstrained — extraction yields null and Postgres treats nulls as distinct — so for a composite, a row missing *any* member never collides. On an org table every index leads with `organization_id`, making uniqueness per-tenant rather than global. A violation raises out of `save` as a `DbException` and rolls the unit of work back.
- **Paths are type-checked against the *stored* shape, and validated where they are written.** The set is generic over the aggregate's state, so `withPath("stauts")` is a compile error, including for nested keys like `"customer.ctiy"`. One level down, paths follow what `serialize()` actually stores: for an n-domain 4.0.2 `DomainObject`/`DomainEntity` member — whose `serialize()` returns `DomainObjectSerialized` — a segment compiles only if a getter of that name is serialized: a derived, undecorated getter is a compile error rather than an always-null index, and a `Date` data key is offered as the string leaf it stores. Any other `serialize()`-bearer — bare, untyped, or even one with a structurally typed return — offers no nested paths at all, because nothing pins its claimed shape to what the serializer emits. `$`-prefixed keys (including the `$typename` every serialized value carries in its type) are excluded from every typed path. Everything else the compiler cannot verify fails closed the same way, to no paths rather than unchecked ones: a level carrying an index signature (its literal keys are unrecoverable), an `any`- or `unknown`-typed member, a `Map`/`Set` member (serializes to `{}`), a mixed union like `string | Customer`, and a union where only some members serialize. Unions where every member is checkable offer their common keys. A malformed path, a bad type or a repeated path throws at the declaration, not when the table is created. Nesting is checked up to six segments deep; past that, and for everything fail-closed above, `SnapshotIndex.forRawPath` is the deliberate way through.
- **The first save verifies the declared paths against the real document.** The one mismatch the types can never see is an explicit `@serialize("customKey")` rename — a decorator cannot change a type, so the path compiles under the getter's name while the data stores the custom key, and the index extracts null from every row. At runtime it *is* detectable with certainty: `serialize()` emits a key for every decorated getter (null-valued ones included), so a declared segment absent from an object carrying `$typename` is definitively a rename, never an omitted optional. Each repository therefore runs `querySet.verifyDocument` against the first snapshot it saves per process — a rename or other wrong-shape declaration throws out of `save` with a message naming the fix, and ambiguous findings (an absent key under a plain parent, which may be an optional) log a single warning instead. Steady-state cost is one `WeakSet` lookup per save. What it can meet late: a rename inside an optional object that is null in every document a process stores — so also assert `MyRepository.indexes.verifyDocument(toSnapshotDocument(aggregate))` is empty in a test, which closes that case at test time.
- **Changing a declaration does not always change the database.** Index creation is `if not exists`, which matches on name alone, and the derived name encodes the paths and `isUnique` but *not* `type`. So adding `JsonValueType.numeric` to a path that already has an index silently keeps the old uncast index — queries then seq-scan while looking indexed. Likewise, clearing `unique` never drops the `_uq` index, so the constraint stays enforced, and migrating a path from scalar to array leaves the old btree in place. All need the index dropped by hand; nothing here alters or drops. An existing table also keeps its columns. An array index carries a `_gin` suffix for the same reason a unique one carries `_uq` — so name matching can never silently keep an index built with the wrong access method.
- **Adding to a declaration does not change the database either.** Migrations are versioned by class name and never re-run, so a path added to the query set after `ExDbMigration_1` ran needs a *new* migration that calls the create method again — the re-run is cheap, since `if not exists` creates only what is missing. This is the likeliest day-2 mistake in the API: the new path compiles, queries, and sequential-scans forever, with nothing failing anywhere.
- **Verify the database against the declaration — drift never fails on its own.** Every gap above is invisible until something reads the catalog and compares, which is what `DbTableCreator.verifySnapshotTableForAggregate(Order, OrderRepository.indexes)` does (org and event-stream variants exist). It touches nothing and returns every divergence as a `SnapshotDriftIssue`: a missing table, a missing index (the message carries the exact `create index` DDL), a cast, uniqueness, access-method or column mismatch — all `fatal`, meaning a migration is needed — and `advisory` orphans, indexes under the `idx_<table>` convention that no current declaration produces (the residue of a changed declaration, or a deliberate hand-built one like the `text_pattern_ops` index above; a unique orphan's message says it still constrains writes). The comparison is structural, from `pg_catalog` — a cast mismatch is caught by the index column's *result type*, however Postgres prints the expression. Run it as the last step of a migration run and throw on any `fatal`, or assert it empty in an integration test, the same idiom as `verifyDocument`: `assert.deepStrictEqual(await creator.verifySnapshotTableForAggregate(Order, OrderRepository.indexes), [])`. What it deliberately does not answer: whether the planner *uses* an index for a given predicate (ask `explain`), or anything about rows written before a declaration changed.
- **Fixing drift is a migration like any other.** The process, in order: (1) never edit a migration that has run — the fix goes in the *next* one, `ExDbMigration_N+1`. (2) In it, execute each fatal issue's `fix` — every fatal issue whose remedy is a statement carries one, executable as-is: the `create index` DDL for a missing index, `drop index if exists …; create …` for a mismatched one. Equivalently, drop what was flagged and re-call the same create method; `if not exists` fills every gap from the current declaration. (3) Orphans are a judgment call, which is why they are `advisory` and carry no `fix`: drop one by hand if it is the residue of a changed declaration, keep it if it is deliberate — like the hand-built `text_pattern_ops` index above. (4) `table-missing` means the creating migration has not run here — run migrations rather than writing a fix; `column-missing` needs a hand-written `alter table` with a backfill decision no canned statement can make. (5) End the migration by verifying again and throwing on any fatal — the same call that found the drift is the proof it was fixed.
- **`reconcile` runs that process mechanically — and is the one method here that drops anything.** `reconcileSnapshotTableForAggregate(Order, OrderRepository.indexes)` (org variant exists) is verify → execute each fatal `fix` → verify again, returning `{ fixed, remaining }` — where a non-empty `remaining` is a legitimate outcome, holding the advisories it never touches and the fatals no statement can fix. It refuses to act at all on `table-missing` (that is an unmigrated database, and reconciling past it would silently stand in for migration history) or `column-missing` (the org index fixes would themselves fail); everything comes back in `remaining` and nothing executes. Each fix is one multi-statement command, which is one implicit transaction — so a unique recreate that fails over data that has grown duplicates rolls its drop back and leaves the old index standing, the `DbException` propagates, and a re-run resumes, since everything is detection-driven. Call it where migrations run: a plain `create index` blocks writes to the table for the duration of the build. No event-stream variant exists on purpose — the event-stream create *is* its reconcile.

- **`query` owns the statement; you own the predicate.** The select list is always `data` and the table is always the repository's own, so what you pass is the `where` predicate without the keyword — and it is parenthesized, so a top-level `or` in it cannot escape. `order by`, `limit` and `offset` go on the `RepositoryQuery` object form, which also covers the no-predicate case (`{}`). Passing a whole `select ... from ...` throws with a message saying so, rather than reaching Postgres. Use `queryRaw` for a projection that does not map onto the aggregate, and `queryStatement` — `queryAcrossOrganizations` on an org repository — for a statement the built shape cannot express. All of this is the **snapshot** repositories; the event stream repositories have no `query`.
- **A predicate is always a `SnapshotPredicate`, and always carries its own values.** There is no bare-string form and no positional parameters: a hand-written fragment goes through `querySet.raw(sql, ...params)`, which validates it — rejecting a whole statement, a retained `where` keyword, or a `;` — and binds its own values. The string door that used to sit beside it validated the same things *differently*, and `raw` parenthesizes what it is given, so a fragment through `raw` arrived downstream as `(select …)` and sailed past guards the string form would have failed. One door, one set of rules, one source of values.
- **An event stream repository reads by id, or in full, and nothing else.** `get`, `getByIds`, `getAll` and `save` are the whole surface, by design. Its table carries one index — the unique `(aggregate_id, aggregate_version)` — so there is nothing else to query *by*; and because rows are grouped by aggregate id and replayed, a predicate on event content either throws `no created event passed` or silently rebuilds the aggregate at an earlier version. Content-based questions are answered by `getAll()` plus in-memory filtering, which is what the class is for until a stream outgrows it — and then the answer is a snapshot repository, not a bigger read. For a projection over the raw event rows, `queryRaw` is still there.
- **`getAll()` takes no arguments; `getByIds(ids)` takes an array.** The split is the point. As one method — `getAll(...ids)` — "called with no arguments" and "spread an empty list" were the *same call*, so the empty case had to stand for either everything or nothing, and whichever it meant, the callers expecting the other got it silently. Separate signatures let both meanings exist unambiguously: `getByIds([])` returns nothing and is unremarkable because you passed an array, and `getAll()` is unbounded and can only be reached on purpose. On an org repository both are scoped to the current organization; `getAll()` there is one tenant's rows, never the whole table.
- **`save` commits; `saveWithin` does not.** `save(value)` runs in the repository's own unit of work and commits it, or rolls it back and rethrows. `saveWithin(value, unitOfWork)` writes into a transaction you own and leaves it open, which is how several repositories' writes are made atomic. These used to be one method with an optional second argument, so `repo.save(v, repo.unitOfWork)` — passing the repository's own unit of work, which is a public getter — silently suppressed the commit while reading as though it changed nothing. Note that `save` commits the shared unit of work *whole*, including anything another repository queued on it.
- **`organization_id` is filtered for you on an org-scoped repository.** `query`, `exists` and `count` prepend it, ahead of your predicate, so it is both the tenant isolation and the leading index column every btree index on the table needs. There is nothing to forget. The two doors that step outside it are both named for it — `queryAcrossOrganizations` for a statement, `queryRawAcrossOrganizations` for a projection — and `organizationPredicate` hands back the filter so a hand-written statement can put it back rather than re-deriving it.

Things to get right about **array containment** specifically:

- **A multi-field match must be one document.** `contains({ userId, isDeactivated: false })` emits one `@>` and requires both fields on the *same* element. Two `contains()` fragments ANDed ask a weaker question — some element has the userId, some *possibly different* element is active — and nothing in the SQL distinguishes them. This is why the declaration hands back a predicate rather than an expression, and it is pinned by a test that seeds a team where the two are different members.
- **`@>` is not `=`, and it is the only operator the index serves.** `(data->'members') = ...` asks whether the array is *exactly* that array, and sequential-scans while doing it. There is deliberately no way to get the bare expression out of `SnapshotArrayIndex`.
- **The `?` operators are unreachable, twice over.** jsonb's `?`, `?|` and `?&` are knex's positional-binding character, so an unescaped one throws `Expected N bindings, saw M` on first call, and the `\?` escape survives only because the pg dialect strips it. `jsonb_path_ops` supports none of them, so the trap is closed at the database too. Same for `@?`/jsonpath, whose filter syntax is literally `? (...)` and which would need caller values interpolated into a jsonpath string. Contains-any is an OR of `@>` terms instead, which the planner turns into a BitmapOr over the same index.
- **Containment is set-like and partial.** Order and multiplicity are irrelevant, so `containsAll` cannot express "has two of these"; and a match names a *subset* of an element's fields, so `{ userId }` matches an element that also carries `role`. An element that *omits* a named field never matches one.
- **An empty match list throws**, because `@> '[]'` is true for every array — `containsAll([])` would silently return the whole table. So does an empty record, `null`, `undefined`, `NaN` and `Infinity`: all four of the latter render as `null` through `JSON.stringify`, turning a bug into a null-element match.
- **Absence and negation.** A row with no `members` key extracts SQL NULL, and `NULL @> anything` is NULL — absent rows correctly never match, but `not (<fragment>)` does not return them either, and does not use the index.
- **GIN does not help `order by` and never does an index-only scan.** Every plan is a bitmap heap scan with a recheck, and the bitmap is built in full before the first row — so `limit 10` over a common element still walks every matching entry. Selectivity is also a flat constant, since jsonb has no `typanalyze`, so a predicate matching a large fraction of rows can get a bitmap plan worse than the seq scan it displaced. **If membership queries need ordering, pagination, counts, negation or prefix search on the element, a normalized side table is the answer and this API is not.**
- **Write amplification.** The snapshot table is upserted on every `save`, and an expression index on `data` means an update can never be HOT — so every save touches every GIN index whether or not the array changed. `fastupdate` (on by default) buffers into a pending list that every query also scans; `gin_pending_list_limit` and `alter index ... set (fastupdate = off)` are the knobs, which this API does not express, the same posture it takes on `text_pattern_ops`.
- **Only arrays of scalars, or of flat scalar records, are offered — judged by the *stored* element shape.** An n-domain 4.0.2 `DomainObject` element is judged by, and matched against, its serialized record (`DomainObjectSerialized`): when that record is flat the array is indexable, and the `$typename` each stored element also carries never blocks a match, since `@>` is subset matching — though it is not a *typed* match key: `$`-prefixed keys are stripped from the typed `contains` document, consistent with every other typed surface. An array of `serialize()`-bearers that are not `DomainObject`s is a compile error, because nothing checkable ties a match document to the stored shape; and an explicit `@serialize("customKey")` rename stays invisible to the type, so a document built from the TypeScript name would match nothing, silently. Plain object literals are safe, since nested plain objects are copied through `JSON.parse(JSON.stringify(...))`. `forRawPath` is the door for everything else, where the caller owns knowing the stored shape — its `containmentForRawPath` defaults `TElement` to `never`, so supply the element shape, or `<any>` to explicitly own the lack of checking — and a raw match document may name `$typename`, which is the escape hatch for filtering a polymorphic element by its stored type.
- **jsonb normalizes numbers to `numeric`**, so `'[1]' @> '[1.0]'` is true. Both sides of this API stringify from JavaScript so they agree by construction; a value written by an ETL or a manual `update` may not. Prefer string elements for anything that is really a code or an id.
- **No `unique`, and one path per array index.** Postgres rejects `create unique index ... using gin` outright, and a multicolumn GIN would need `btree_gin`. Two membership predicates ANDed are two GIN scans BitmapAnd-ed, which is what you want anyway.
- **On an org table an array index does not lead with `organization_id`** — a multicolumn GIN over a varchar needs `btree_gin`, which is not trusted on Postgres 12 and would demand superuser at migration time. So declaring one always creates the standalone `(organization_id)` btree for the planner to BitmapAnd against, and `info.createdIndexes[i].leadingColumn` is `undefined` for it. `query` filters `organization_id` either way: that is tenant isolation, independent of the plan.
- **Fragments compose through `and`/`or`, never by hand.** A containment predicate carries its own values, so there is nothing to splice or spread: on its own it goes straight through as `this.query(p)`, and combined it goes through a combinator — `this.query(this.querySet.and(p, this.querySet.eq("status", "active")))` — which merges `sql` and `params` in matching order and parenthesizes the result. The positional form (`this.query(p.sql, ...p.params)`) no longer exists: `query` takes only a `SnapshotPredicate` or a `RepositoryQuery`, and a predicate accompanied by loose positional values is rejected.

#### Breaking changes in v8

No reindexing and no data migration; every index and every emitted statement is byte-identical to v7's.

1. **n-domain 4.0.2 is required, and nested typed paths follow it exclusively.** Typed paths, array paths, and containment element shapes now come from `DomainObjectSerialized` — offered only for real n-domain `DomainObject`/`DomainEntity` members. A state member typed as a bare or custom `Serializable` — even with a structurally typed `serialize()` — no longer offers nested paths: convert it to a `DomainObject`, or go through `forRawPath`.
2. **`$`-prefixed keys are excluded from every typed surface** — paths, array paths, and `contains` match keys. (n-domain 4.0.2 put `$typename` into the serialized *type*, which would otherwise offer paths the segment validation rejects at runtime.) The raw doors are unchanged, and a `containmentForRawPath` match document still takes `$typename`.
3. **`verifyDocument` takes `SnapshotDocumentOf<TState>`.** Replace `verifyDocument(aggregate.snapshot() as object)` with `verifyDocument(toSnapshotDocument(aggregate))`.
4. **`containmentForRawPath` no longer defaults `TElement` to `any`.** The default is `never`, under which no match document can be built — supply the stored element shape, or write `containmentForRawPath<any>(path)` to keep the old unchecked behavior explicitly.
5. **Org snapshot reads are now typed under the correct org state type** (they were typed under the bare `AggregateState`) — a type-level fix with no behavioral change.
6. **A declaration path must be an inline literal.** `withPath(someVariable)` — a variable typed as the path union — used to compile and silently widen the declared-path record to every state path, discarding path and cast checking; it is a compile error now, as is a widened spec array or member in `withComposite` and a widened `withArrayPath` argument. Inline literals are unaffected. A genuinely computed key goes through `SnapshotIndex.forRawPath`, as before.
7. **`SnapshotTableInfo.createdIndexes` now includes the standalone `(organization_id)` index** the org create adds when no btree declaration covers that column — reported with empty `paths` and the column as `leadingColumn`. It was created but unreported before; a test doing `deepStrictEqual` on `createdIndexes` for such a table will see the extra entry.

### Caching

```typescript
import { CacheService, RedisCacheService } from '@nivinjoseph/n-data';
import { Duration } from '@nivinjoseph/n-util';
import { createClient } from 'redis';

// Create Redis client
const redisClient = await createClient({}).connect();

// Create cache service
const cacheService = new RedisCacheService(redisClient);

// Store values with different types
await cacheService.store('number-key', 42);
await cacheService.store('string-key', 'hello world');
await cacheService.store('boolean-key', true);
await cacheService.store('object-key', { foo: { bar: null } });

// Store with expiration
await cacheService.store('expiring-key', 'value', Duration.fromSeconds(30));

// Retrieve values
const number = await cacheService.retrieve<number>('number-key');
const string = await cacheService.retrieve<string>('string-key');
const boolean = await cacheService.retrieve<boolean>('boolean-key');
const object = await cacheService.retrieve<{ foo: { bar: null } }>('object-key');

// Check if key exists
const exists = await cacheService.exists('number-key');

// Remove values
await cacheService.remove('number-key');

// Cleanup
await cacheService.dispose();
await redisClient.close();
```

### File Storage

```typescript
import { S3FileStore, S3FileStoreConfig, StoredFile } from '@nivinjoseph/n-data';
import { Duration } from '@nivinjoseph/n-util';

// Configure S3 storage. Two buckets, not one: `makePublic` copies an object from the
// private bucket into the public one — the private copy stays. `storedFileSignatureKey`
// is required; it signs the StoredFile, and reads verify that signature, so a client
// cannot hand back a tampered one.
const config: S3FileStoreConfig = {
    region: 'us-east-1',
    privateBucket: 'my-private-bucket',
    publicBucket: 'my-public-bucket',
    storedFileSignatureKey: 'a-secret-signing-key',
    // Optional, and all-or-nothing: supply both or neither. Omitted, the AWS SDK
    // resolves credentials from the environment as usual.
    accessKeyId: 'your-access-key',
    secretAccessKey: 'your-secret-key'
};

// Create file store
const fileStore = new S3FileStore(config);

// `store` returns a StoredFile — the handle every other method takes. It carries the
// name, ext, size, mime, hash, signature and urls; it is not a path string.
const stored: StoredFile = await fileStore.store('report.pdf', buffer);

// Reads take the StoredFile, not a path
const data: Buffer = await fileStore.retrieve(stored);

// Promote to the public bucket; returns a new StoredFile carrying `publicUrl`
const published = await fileStore.makePublic(stored);

// Or hand the client a presigned url instead of proxying the bytes. Both return a
// StoredFile whose `privateUrl` is the presigned url — despite the name, that is the
// field to hand out. Default and maximum expiry is 7 days.
const upload = await fileStore.createSignedUpload('report.pdf', buffer.length, fileHash);
const download = await fileStore.createSignedDownload(stored, Duration.fromHours(1));
```

`StoredFile` is a serializable domain entity, so it round-trips through your own storage:
persist it beside whatever references the file, and pass it back to `retrieve` later.
Reads verify its signature, so it must round-trip intact.

### Distributed Locking

```typescript
import { RedisDistributedLockService, DistributedLockConfig } from '@nivinjoseph/n-data';
import { Duration } from '@nivinjoseph/n-util';
import { createClient } from 'redis';

// The service takes a Redis client — it does not connect for you, so there is no
// host/port on the config
const redisClient = await createClient({}).connect();

// Optional. Every field has a default, so `new RedisDistributedLockService(client)`
// is the normal case. Durations are `Duration`, not numbers.
const config: DistributedLockConfig = {
    retryCount: 3,
    retryDelay: Duration.fromMilliSeconds(400),
    retryJitter: Duration.fromMilliSeconds(200)
};

// Create lock service — client first, config second and optional
const lockService = new RedisDistributedLockService(redisClient, config);

// Acquire and release locks
const lock = await lockService.lock('resource-key', Duration.fromSeconds(30));
try {
    // Perform locked operation
} finally {
    await lock.release();
}
```

Two things to know about keys:

- **Lock keys are trimmed and lowercased.** `lock('UserA')` and `lock('usera')` take the
  same lock. If your keys are case-sensitive ids, prefix or encode them so two distinct
  ids cannot fold together. `UnableToAcquireDistributedLockException` reports the
  transformed key, not the one you passed.
- **`RedisCacheService` prefixes cache keys with `bin_`; `InMemoryCacheService` does
  not.** The two `CacheService` implementations are therefore not reading each other's
  keys — relevant only if you swap implementations against data already in Redis.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
