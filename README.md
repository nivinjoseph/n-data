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

- Node.js >= 20.10
- PostgreSQL database
- Redis (for distributed locking and caching features)

## Usage

### Database Operations

```typescript
import { KnexPgDb, DbConnectionConfig, KnexPgDbConnectionFactory } from '@nivinjoseph/n-data';

// Configure database connection
const config: DbConnectionConfig = {
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'postgres',
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

    // required by the base, which declares it abstract at a widened type — forgetting it is a compile
    // error, and the `typeof` is what carries the narrow type to the call sites
    protected override get indexes(): typeof OrderRepository.indexes { return OrderRepository.indexes; }

    public constructor(eventStreamRepository: OrderEventStreamRepository)
    {
        super(eventStreamRepository);
    }

    // `query` owns the statement — `select data from <table> where (<predicate>)` — so what you
    // pass is a predicate built from the set above.
    public getByStatus(status: string): Promise<Array<Order>>
    {
        return this.query(this.indexes.eq("status", status));
    }

    // a number, because `total` declared a numeric cast. Without one this would not compile —
    // uncast, the extraction compares as text and '9' > '100'.
    public getOverTotal(total: number): Promise<Array<Order>>
    {
        return this.query(this.indexes.gt("total", total));
    }

    public getByTag(tag: string): Promise<Array<Order>>
    {
        return this.query(this.indexes.contains("tags", tag));
    }

    // predicates compose, and every combinator parenthesizes its result
    public getRushIn(city: string, statuses: ReadonlyArray<string>): Promise<Array<Order>>
    {
        return this.query(this.indexes.and(
            this.indexes.eq("customer.city", city),
            this.indexes.in("status", statuses)));
    }

    // Ordering and paging go on the object form, which also takes no predicate at all
    public getLargestOrders(count: number): Promise<Array<Order>>
    {
        return this.query({ orderBy: this.indexes.orderBy("total", "desc"), limit: count });
    }

    // A projection that does not map onto the aggregate goes through queryRaw,
    // which performs no deserialization. `expressionFor` hands back the indexed expression.
    public async getCountByStatus(): Promise<ReadonlyArray<{ status: string; count: number; }>>
    {
        const result = await this.queryRaw<{ status: string; count: number; }>(
            `select ${this.indexes.expressionFor("status")} as status, cast(count(*) as int) as count
             from ${this.table} group by 1;`);

        return result.rows;
    }
}
```

The paths a query can name are exactly the ones declared above — not merely the ones that exist on `OrderState`:

```typescript
this.indexes.eq("status", "sent");        // ok
this.indexes.eq("placedAt", "2024-01");   // error: on OrderState, but never declared here
this.indexes.eq("total", "100");          // error: total is a number
this.indexes.eq("nope", "x");             // error: not a path on OrderState
this.indexes.contains("status", "sent");  // error: status is not an array path
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

    protected override get indexes(): typeof TeamRepository.indexes { return TeamRepository.indexes; }

    public constructor(eventStreamRepository: TeamEventStreamRepository)
    {
        super(eventStreamRepository);
    }

    public getActiveTeamsForUser(userId: string): Promise<Array<Team>>
    {
        // ONE containment document, so both fields must hold on the SAME member element.
        // `{ userld }` or `{ isDeactivated: "false" }` would be compile errors — the element
        // type is resolved from the path literal.
        return this.query(this.indexes.contains("members", { userId, isDeactivated: false }));
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

`createSnapshotTableForAggregate` takes a `SnapshotQuerySet`, an options object carrying both kinds — `{ indexes, arrayIndexes }` — or a bare index array. A set satisfies the options shape by construction, since `indexes` and `arrayIndexes` are exactly its two getters.

`SnapshotIndex` and `SnapshotArrayIndex` remain public underneath, for the path a typed signature cannot name — a computed key, a `$`-prefixed serialized name, a whole subtree — through their `forRawPath` doors. Pass such a declaration alongside a set's own.

If a migration should not import a repository, put the set in a module both import — the point is that one declaration is the source of both the index and the predicate, not where it lives.

```typescript
import { OrgSnapshotBaseRepository, SnapshotQuerySet } from '@nivinjoseph/n-data';

// 3. Organization-scoped aggregates: `query` adds the organization filter itself
@inject("InvoiceEventStreamRepository")
export class InvoiceRepository extends OrgSnapshotBaseRepository<Invoice, InvoiceState, InvoiceEvent>
{
    public static readonly indexes = SnapshotQuerySet.for<InvoiceState>().withPath("status");

    protected override get indexes(): typeof InvoiceRepository.indexes { return InvoiceRepository.indexes; }

    public constructor(eventStreamRepository: InvoiceEventStreamRepository)
    {
        super(eventStreamRepository);
    }

    public getByStatus(status: string): Promise<Array<Invoice>>
    {
        // identical to the plain variant above — `organization_id = ?` is prepended for you,
        // ahead of this predicate, which is both the isolation and the leading index column
        return this.query(this.indexes.eq("status", status));
    }

    // -> select data from invoice_snaps
    //    where organization_id = ? and (((data->>'status') = ?));
}
```

A read that is genuinely meant to span tenants — and only that — goes through `queryAcrossOrganizations`, which takes a whole statement and adds nothing to it. It is named for its consequence so the tenant implication is visible at the call site. On the plain snapshot repository the same escape hatch is called `queryStatement`, since there is no tenant scope to step outside of; it is there for the joins, unions and CTEs the built statement cannot express.

Both belong to the **snapshot** repositories only. An event stream repository reads by aggregate id or in full and offers no query surface at all — see below.

Things to get right:

- **Every expression comes from a declaration.** Postgres only uses an expression index when the query expression matches the indexed one *textually*. A near-miss — `data->>'total'` against an index on `((data->>'total')::numeric)` — silently falls back to a sequential scan, with no error and no warning. The expression *builder* is private to `SnapshotIndex`, so an expression can only originate from a declaration that also emits the DDL, and the set hands back the exact string its index was created from. A planner test proves the match, and proves the near-miss above does not.
- **A query can only name a path the set declared.** Not merely one that exists on the state: `TIndexed` is the record of declared paths, so `eq("placedAt", …)` on an undeclared path is a compile error, and so is `orderBy` or `expressionFor` on one. That is what closes the gap the older pattern left open, where an index could be declared, queried, and never actually created.
- **A numeric path needs a cast to be compared as a number.** `withPath("total", { type: JsonValueType.numeric })` is what makes `gt("total", 100)` compile; declared without one, the same call is rejected, because an uncast extraction compares as text and `'9' > '100'`. Text needs no cast (Postgres elides a redundant `::text`), and a boolean compares correctly as `'true'`/`'false'` for equality.
- **Matching the expression is necessary but not sufficient.** A btree index only serves a predicate that constrains a *leading prefix* of its columns, so the second path of a composite — or any path on an org table, since those indexes lead with `organization_id` — is not independently searchable however exactly the expression matches. Read `info.indexes` from the create call for each index's grouping, column order and `leadingColumn`. Both halves are verified against Postgres by planner tests, not just asserted here.
- **`organizationId` is not an indexable path.** An org-scoped state declares it, but on the table it is a real column, and every index leads with it — so constraining the column does use those indexes, while the copy inside `data` is not what any index covers. `forPath("organizationId")` is therefore a compile error. The exclusion is unconditional, so a *plain* aggregate that legitimately keeps a top-level `organizationId` in `data` reaches it through `forRawPath`.
- **A prefix `LIKE` does not use the index** unless the database collation is `C`. The default text opclass serves `=`, ranges and `order by`, but `like 'abc%'` sequential-scans past a perfectly good index on a typical `en_US.utf8` database. `text_pattern_ops` is the fix and this API does not express opclasses — build that index by hand in a migration if a prefix search has to be fast.
- **`unique` compares the extracted text exactly.** Nothing is folded or trimmed, so a "unique email" index accepts `a@x.com`, `A@x.com` and `" a@x.com "` as three distinct values. There is no `lower()` option on purpose — every extra expression form is another spelling the read side must match. Normalize in the domain, before the value reaches the snapshot.
- **Only leaf scalars are `SnapshotIndex`-able.** A container key (`"customer"`, `"members"`) is a compile error, because indexing one covers jsonb's own text rendering of the subtree — which orders keys itself, so a predicate built with `JSON.stringify` would never match. Reach the leaf (`"customer.city"`), take an *array* key to `SnapshotArrayIndex` instead, or use `forRawPath` if you really want the subtree. The two path unions are disjoint by construction, so a key belongs to exactly one kind of index — and declaring one path as both is rejected.
- **Index bounded values only.** A btree index tuple must fit 2704 bytes *after compression*, checked on insert rather than at create time — so a repetitive 4KB value indexes fine while an incompressible one of the same length permanently fails `save`. Index codes, enums, ids, numbers and timestamps, not free text.
- **Pass a `type` whenever the value is not a string**, and leave it off when it is — extraction already yields `text`, and Postgres *elides* a redundant `::text`, so an index built with `JsonValueType.text` is byte-for-byte the same index as one built without it and their predicates are interchangeable. It is the one case where two different expression strings are equivalent. An uncast comparison sorts lexicographically, making `'9' > '100'` true, so this is a correctness concern and not just a performance one. Each path carries its own cast, so a composite can mix types. `JsonValueType` has no date/time members, because those parse through non-immutable functions that Postgres rejects in an index expression — store a timestamp as epoch millis and use `JsonValueType.bigint`, or as an ISO-8601 string and leave it as text, which sorts chronologically anyway.
- **Uniqueness covers the whole index.** One path constrains that value; several constrain the tuple, so `withComposite(["tenantCode", "sku"], { unique: true })` allows a repeated `tenantCode` as long as the pair differs. Rows whose `data` omits an indexed key are unconstrained — extraction yields null and Postgres treats nulls as distinct — so for a composite, a row missing *any* member never collides. On an org table every index leads with `organization_id`, making uniqueness per-tenant rather than global. A violation raises out of `save` as a `DbException` and rolls the unit of work back.
- **Paths are type-checked, and validated where they are written.** The set is generic over the aggregate's state, so `withPath("stauts")` is a compile error, including for nested keys like `"customer.ctiy"`. A malformed path, a bad type or a repeated path throws at the declaration, not when the table is created. Nesting is checked up to six segments deep; past that, and for a computed or `$`-prefixed key, `SnapshotIndex.forRawPath` is the way through.
- **Changing a declaration does not always change the database.** Index creation is `if not exists`, which matches on name alone, and the derived name encodes the paths and `isUnique` but *not* `type`. So adding `JsonValueType.numeric` to a path that already has an index silently keeps the old uncast index — queries then seq-scan while looking indexed. Likewise, clearing `unique` never drops the `_uq` index, so the constraint stays enforced, and migrating a path from scalar to array leaves the old btree in place. All need the index dropped by hand; nothing here alters or drops. An existing table also keeps its columns. An array index carries a `_gin` suffix for the same reason a unique one carries `_uq` — so name matching can never silently keep an index built with the wrong access method.

- **`query` owns the statement; you own the predicate.** The select list is always `data` and the table is always the repository's own, so what you pass is the `where` predicate without the keyword — and it is parenthesized, so a top-level `or` in it cannot escape. `order by`, `limit` and `offset` go on the `RepositoryQuery` object form, which also covers the no-predicate case (`{}`). Passing a whole `select ... from ...` throws with a message saying so, rather than reaching Postgres. Use `queryRaw` for a projection that does not map onto the aggregate, and `queryStatement` — `queryAcrossOrganizations` on an org repository — for a statement the built shape cannot express. All of this is the **snapshot** repositories; the event stream repositories have no `query`.
- **An event stream repository reads by id and nothing else.** `get`, `getAll` and `save` are the whole surface, by design. Its table carries one index — the unique `(aggregate_id, aggregate_version)` — so there is nothing else to query *by*; and because rows are grouped by aggregate id and replayed, a predicate on event content either throws `no created event passed` or silently rebuilds the aggregate at an earlier version. Querying is what the snapshot table is for. For a projection over the raw event rows, `queryRaw` is still there.
- **`organization_id` is filtered for you on an org-scoped repository.** `query` prepends it, ahead of your predicate, so it is both the tenant isolation and the leading index column every btree index on the table needs. There is nothing to forget. Stepping outside it takes the explicitly-named `queryAcrossOrganizations`.

Things to get right about **array containment** specifically:

- **A multi-field match must be one document.** `contains({ userId, isDeactivated: false })` emits one `@>` and requires both fields on the *same* element. Two `contains()` fragments ANDed ask a weaker question — some element has the userId, some *possibly different* element is active — and nothing in the SQL distinguishes them. This is why the declaration hands back a predicate rather than an expression, and it is pinned by a test that seeds a team where the two are different members.
- **`@>` is not `=`, and it is the only operator the index serves.** `(data->'members') = ...` asks whether the array is *exactly* that array, and sequential-scans while doing it. There is deliberately no way to get the bare expression out of `SnapshotArrayIndex`.
- **The `?` operators are unreachable, twice over.** jsonb's `?`, `?|` and `?&` are knex's positional-binding character, so an unescaped one throws `Expected N bindings, saw M` on first call, and the `\?` escape survives only because the pg dialect strips it. `jsonb_path_ops` supports none of them, so the trap is closed at the database too. Same for `@?`/jsonpath, whose filter syntax is literally `? (...)` and which would need caller values interpolated into a jsonpath string. Contains-any is an OR of `@>` terms instead, which the planner turns into a BitmapOr over the same index.
- **Containment is set-like and partial.** Order and multiplicity are irrelevant, so `containsAll` cannot express "has two of these"; and a match names a *subset* of an element's fields, so `{ userId }` matches an element that also carries `role`. An element that *omits* a named field never matches one.
- **An empty match list throws**, because `@> '[]'` is true for every array — `containsAll([])` would silently return the whole table. So does an empty record, `null`, `undefined`, `NaN` and `Infinity`: all four of the latter render as `null` through `JSON.stringify`, turning a bug into a null-element match.
- **Absence and negation.** A row with no `members` key extracts SQL NULL, and `NULL @> anything` is NULL — absent rows correctly never match, but `not (<fragment>)` does not return them either, and does not use the index.
- **GIN does not help `order by` and never does an index-only scan.** Every plan is a bitmap heap scan with a recheck, and the bitmap is built in full before the first row — so `limit 10` over a common element still walks every matching entry. Selectivity is also a flat constant, since jsonb has no `typanalyze`, so a predicate matching a large fraction of rows can get a bitmap plan worse than the seq scan it displaced. **If membership queries need ordering, pagination, counts, negation or prefix search on the element, a normalized side table is the answer and this API is not.**
- **Write amplification.** The snapshot table is upserted on every `save`, and an expression index on `data` means an update can never be HOT — so every save touches every GIN index whether or not the array changed. `fastupdate` (on by default) buffers into a pending list that every query also scans; `gin_pending_list_limit` and `alter index ... set (fastupdate = off)` are the knobs, which this API does not express, the same posture it takes on `text_pattern_ops`.
- **Only arrays of scalars, or of flat scalar records, are offered.** An array of `Serializable` is a compile error, because `serialize()` emits `@serialize` decorated getters only, under `field.key ?? field.name`, plus a `$typename` nobody wrote — so a document built from the TypeScript names would match nothing, silently. Plain object literals are safe, since nested plain objects are copied through `JSON.parse(JSON.stringify(...))`. `forRawPath` is the door for everything else, where the caller owns knowing the stored shape.
- **jsonb normalizes numbers to `numeric`**, so `'[1]' @> '[1.0]'` is true. Both sides of this API stringify from JavaScript so they agree by construction; a value written by an ETL or a manual `update` may not. Prefer string elements for anything that is really a code or an id.
- **No `unique`, and one path per array index.** Postgres rejects `create unique index ... using gin` outright, and a multicolumn GIN would need `btree_gin`. Two membership predicates ANDed are two GIN scans BitmapAnd-ed, which is what you want anyway.
- **On an org table an array index does not lead with `organization_id`** — a multicolumn GIN over a varchar needs `btree_gin`, which is not trusted on Postgres 12 and would demand superuser at migration time. So declaring one always creates the standalone `(organization_id)` btree for the planner to BitmapAnd against, and `info.indexes[i].leadingColumn` is `undefined` for it. `query` filters `organization_id` either way: that is tenant isolation, independent of the plan.
- **Splice `sql` and spread `params` in the same order.** On its own a fragment goes straight through: `this.query(p.sql, ...p.params)`. Combined with another, `` this.query(`${p.sql} and ${expression} = ?`, ...p.params, value) `` — and the reverse order takes the values reversed too. Positional binding is unforgiving.

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
import { S3FileStore, S3FileStoreConfig } from '@nivinjoseph/n-data';

// Configure S3 storage
const config: S3FileStoreConfig = {
    region: 'us-east-1',
    bucket: 'my-bucket',
    accessKeyId: 'your-access-key',
    secretAccessKey: 'your-secret-key'
};

// Create file store
const fileStore = new S3FileStore(config);

// Store and retrieve files
await fileStore.store('path/to/file.txt', buffer);
const file = await fileStore.retrieve('path/to/file.txt');
```

### Distributed Locking

```typescript
import { RedisDistributedLockService, DistributedLockConfig } from '@nivinjoseph/n-data';
import { Duration } from '@nivinjoseph/n-util';

// Configure distributed lock
const config: DistributedLockConfig = {
    host: 'localhost',
    port: 6379,
    retryCount: 3,
    retryDelay: 1000
};

// Create lock service
const lockService = new RedisDistributedLockService(config);

// Acquire and release locks
const lock = await lockService.lock('resource-key', Duration.fromSeconds(30));
try {
    // Perform locked operation
} finally {
    await lock.release();
}
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
