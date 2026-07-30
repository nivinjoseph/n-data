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

Aggregates are stored as an append-only event stream plus a snapshot of the current state. Reads by id are served by the snapshot table's primary key. To query a field *inside* the snapshot's `data` column, declare a `SnapshotIndex` for it — `DbTableCreator` builds a btree expression index over the extraction expression, without adding a column to the table.

Declare each index on the repository that queries it. One instance produces the index *and* hands back the expression to query it with, so the written index and the predicate cannot drift apart; the migration then consumes the same declarations.

```typescript
import { SnapshotBaseRepository, SnapshotIndex, JsonValueType } from '@nivinjoseph/n-data';
import { inject } from '@nivinjoseph/n-ject';

// 1. Declare the indexes next to the queries that use them
@inject("OrderEventStreamRepository")
export class OrderRepository extends SnapshotBaseRepository<Order, OrderState, OrderEvent>
{
    // paths are checked against OrderState, so a typo is a compile error
    public static readonly statusIndex = SnapshotIndex.forPath<OrderState>("status");
    public static readonly totalIndex = SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric);
    public static readonly cityIndex = SnapshotIndex.forPath<OrderState>("customer.city");             // nested key
    public static readonly numberIndex = SnapshotIndex.forPath<OrderState>("orderNumber").asUnique();  // a natural key
    public static readonly skuIndex = SnapshotIndex.forPath<OrderState>("tenantCode")                  // a composite one
                                                   .andPath("sku")
                                                   .asUnique();

    public static readonly snapshotIndexes: ReadonlyArray<SnapshotIndex<OrderState>> = [
        OrderRepository.statusIndex, OrderRepository.totalIndex, OrderRepository.cityIndex,
        OrderRepository.numberIndex, OrderRepository.skuIndex
    ];

    // read each expression off the declaration it was created from, once, up front. A path the
    // index does not cover throws here — at module load — rather than on the first call to an
    // untested query method.
    private static readonly _statusExpression = OrderRepository.statusIndex.expressionForPath("status");
    private static readonly _totalExpression = OrderRepository.totalIndex.expressionForPath("total");

    public constructor(eventStreamRepository: OrderEventStreamRepository)
    {
        super(eventStreamRepository);
    }

    public getByStatus(status: string): Promise<Array<Order>>
    {
        return this.query(
            `select data from ${this.table} where ${OrderRepository._statusExpression} = ?;`,
            status);
    }

    public getOverTotal(total: number): Promise<Array<Order>>
    {
        return this.query(
            `select data from ${this.table} where ${OrderRepository._totalExpression} > ?;`,
            total);
    }

    // A projection that does not map onto the aggregate goes through queryRaw,
    // which performs no deserialization.
    public async getCountByStatus(): Promise<ReadonlyArray<{ status: string; count: number; }>>
    {
        const result = await this.queryRaw<{ status: string; count: number; }>(
            `select ${OrderRepository._statusExpression} as status, cast(count(*) as int) as count
             from ${this.table} group by 1;`);

        return result.rows;
    }
}
```

```typescript
import { DbMigration, DbTableCreator, Db } from '@nivinjoseph/n-data';
import { Logger } from '@nivinjoseph/n-log';

// 2. The migration creates the tables from those same declarations
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
        await tableCreator.createSnapshotTableForAggregate(Order, OrderRepository.snapshotIndexes);

        // -> create index ... on order_snaps((data->>'status'));
        //    create index ... on order_snaps(((data->>'total')::numeric));
        //    create index ... on order_snaps((data#>>'{"customer","city"}'));
        //    create unique index ... on order_snaps((data->>'orderNumber'));
        //    create unique index ... on order_snaps((data->>'tenantCode'), (data->>'sku'));
    }
}
```

If a migration should not import a repository, put the declarations in a module both import — the point is that one declaration is the source of both the index and the predicate, not where it lives.

```typescript
import { OrgSnapshotBaseRepository, SnapshotIndex } from '@nivinjoseph/n-data';

// 3. Organization-scoped aggregates: every custom query must filter organization_id
@inject("InvoiceEventStreamRepository")
export class InvoiceRepository extends OrgSnapshotBaseRepository<Invoice, InvoiceState, InvoiceEvent>
{
    public static readonly statusIndex = SnapshotIndex.forPath<InvoiceState>("status");

    public static readonly snapshotIndexes: ReadonlyArray<SnapshotIndex<InvoiceState>> =
        [InvoiceRepository.statusIndex];

    private static readonly _statusExpression = InvoiceRepository.statusIndex.expressionForPath("status");

    public constructor(eventStreamRepository: InvoiceEventStreamRepository)
    {
        super(eventStreamRepository);
    }

    public getByStatus(status: string): Promise<Array<Invoice>>
    {
        // organization_id first: `query` does not add it, and the index leads with it
        return this.query(
            `select data from ${this.table} where organization_id = ? and ${InvoiceRepository._statusExpression} = ?;`,
            this.domainContext.organizationId, status);
    }
}
```

Things to get right:

- **Every expression comes from a declaration.** Postgres only uses an expression index when the query expression matches the indexed one *textually*. A near-miss — `data->>'total'` against an index on `((data->>'total')::numeric)` — silently falls back to a sequential scan, with no error and no warning. The expression *builder* is private to `SnapshotIndex`, so an expression can only originate from a declaration that also emits the DDL, and `expressionForPath` hands back the exact string that index was created from. A planner test proves the match, and proves the near-miss above does not.
- **An index only answers for the paths it covers.** `expressionForPath` checks the path against the state at compile time, but asking one index for a *different* index's path throws. Read expressions into `static` fields, as above, so that surfaces at startup instead of on the first call to an untested method.
- **Matching the expression is necessary but not sufficient.** A btree index only serves a predicate that constrains a *leading prefix* of its columns, so the second path of a composite — or any path on an org table, since those indexes lead with `organization_id` — is not independently searchable however exactly the expression matches. Read `info.indexes` from the create call for each index's grouping, column order and `leadingColumn`. Both halves are verified against Postgres by planner tests, not just asserted here.
- **`organizationId` is not an indexable path.** An org-scoped state declares it, but on the table it is a real column, and every index leads with it — so constraining the column does use those indexes, while the copy inside `data` is not what any index covers. `forPath("organizationId")` is therefore a compile error. The exclusion is unconditional, so a *plain* aggregate that legitimately keeps a top-level `organizationId` in `data` reaches it through `forRawPath`.
- **A prefix `LIKE` does not use the index** unless the database collation is `C`. The default text opclass serves `=`, ranges and `order by`, but `like 'abc%'` sequential-scans past a perfectly good index on a typical `en_US.utf8` database. `text_pattern_ops` is the fix and this API does not express opclasses — build that index by hand in a migration if a prefix search has to be fast.
- **`asUnique` compares the extracted text exactly.** Nothing is folded or trimmed, so a "unique email" index accepts `a@x.com`, `A@x.com` and `" a@x.com "` as three distinct values. There is no `lower()` option on purpose — every extra expression form is another spelling the read side must match. Normalize in the domain, before the value reaches the snapshot.
- **Only leaf scalars are indexable.** A container key (`"customer"`, `"tags"`) is a compile error, because indexing one covers jsonb's own text rendering of the subtree — which orders keys itself, so a predicate built with `JSON.stringify` would never match. Reach the leaf (`"customer.city"`), or use `forRawPath` if you really want the subtree.
- **Index bounded values only.** A btree index tuple must fit 2704 bytes *after compression*, checked on insert rather than at create time — so a repetitive 4KB value indexes fine while an incompressible one of the same length permanently fails `save`. Index codes, enums, ids, numbers and timestamps, not free text.
- **Pass a `type` whenever the value is not a string**, and leave it off when it is — extraction already yields `text`, and Postgres *elides* a redundant `::text`, so an index built with `JsonValueType.text` is byte-for-byte the same index as one built without it and their predicates are interchangeable. It is the one case where two different expression strings are equivalent. An uncast comparison sorts lexicographically, making `'9' > '100'` true, so this is a correctness concern and not just a performance one. Each path carries its own cast, so a composite can mix types. `JsonValueType` has no date/time members, because those parse through non-immutable functions that Postgres rejects in an index expression — store a timestamp as epoch millis and use `JsonValueType.bigint`, or as an ISO-8601 string and leave it as text, which sorts chronologically anyway.
- **Uniqueness covers the whole index.** One path constrains that value; several constrain the tuple, so `forPath("tenantCode").andPath("sku").asUnique()` allows a repeated `tenantCode` as long as the pair differs. Rows whose `data` omits an indexed key are unconstrained — extraction yields null and Postgres treats nulls as distinct — so for a composite, a row missing *any* member never collides. On an org table every index leads with `organization_id`, making uniqueness per-tenant rather than global. A violation raises out of `save` as a `DbException` and rolls the unit of work back.
- **Paths are type-checked, and validated where they are written.** `SnapshotIndex` is generic over the aggregate's state, so `forPath("stauts")` is a compile error, including for nested keys like `"customer.ctiy"`, and so is `expressionForPath("stauts")` when reading one back. A malformed path, a bad type or a repeated path throws at the declaration, not when the table is created. Use `forRawPath` for a computed key outside the state shape. Nesting is checked up to six segments deep; past that, and for `$`-prefixed serialized names, `forRawPath` is the way through.
- **Changing a declaration does not always change the database.** Index creation is `if not exists`, which matches on name alone, and the derived name encodes the paths and `isUnique` but *not* `type`. So adding `JsonValueType.numeric` to a path that already has an index silently keeps the old uncast index — queries then seq-scan while looking indexed. Likewise, clearing `asUnique` never drops the `_uq` index, so the constraint stays enforced. Both need the index dropped by hand; nothing here alters or drops. An existing table also keeps its columns.
- **Select `data`.** `query` deserializes each row from that column. Use `queryRaw` for anything else.
- **Filter `organization_id` in every org-scoped query.** `query` does not add it, so omitting it returns other organizations' aggregates *and* misses the index.

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
