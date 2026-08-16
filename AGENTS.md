# AGENTS.md

Orientation for AI coding agents working in or against `@nivinjoseph/n-data` — a PostgreSQL data
access layer over Knex, with event-sourcing repositories, caching, file storage and distributed
locking. Part of the `@nivinjoseph/n-*` family (DI via `n-ject`, domain types via `n-domain`,
guards via `n-defensive`, `Duration` via `n-util`).

## Ground rules

- **The interfaces in `src/` are the truth.** Where prose and a signature disagree, the signature
  wins. Read the interface before writing a call.
- **ESM only.** `"type": "module"`, `moduleResolution: NodeNext`. Relative imports need explicit
  `.js` extensions, including from `.ts` sources. There is no CJS build and no `require` export.
- **Node >= 24.10.**
- **`src/index.ts` is the whole public surface.** If it is not re-exported there, it is internal —
  including `MigrationDependencyKey` and `OperationType`, so branching on `DbException.operation`
  means comparing against the string literals `"query"` / `"command"`.
- **Guards run before anything else.** Nearly every public method opens with `given(...)` from
  `n-defensive`. Bad input throws immediately with a message that names the argument, so read the
  thrown message literally — it is usually the fix.

## Reading order

1. `README.md` — especially the Event Sourcing section, which is the deepest and most current part.
2. `test-example/README.md` — a compile-checked worked application, plus operational detail the root
   README does not carry.
3. `src/index.ts` — the full export list.
4. `test-example/test/example.test.ts` — end-to-end wiring and the scoping pattern.

For `DbMigrator`, `KnexPgUnitOfWork`, `S3FileStore` and `StoredFile`, read the source: those files
carry no doc comments. The snapshot and repository files, by contrast, are documented in depth and
are worth reading before guessing.

## Where the compiler already protects you

Anything routed through `SnapshotQuerySet` / `SnapshotIndex` / `SnapshotArrayIndex` and the snapshot
repositories is checked at compile time: a path that was never declared, a value of the wrong type,
a numeric comparison or an `orderBy` on a path declared without a cast, a cast that does not fit the
leaf type, and an array operator on a scalar path are all compile errors. Paths follow the *stored*
shape — a nested n-domain 4.0.2 `DomainObject` is walked through its serialized record
(`DomainObjectSerialized`), and *only* real `DomainObject` members get that treatment: any other
`serialize()`-bearer, even one with a structurally typed return, fails closed. So does everything
else the compiler cannot verify — no paths at all rather than unchecked ones (index signatures,
`any`/`unknown`, Map/Set, partially-serializable unions, and every `$`-prefixed key, `$typename`
included) — with `forRawPath` as the deliberate door. Several errors are phrased as instructions —
the *property name* in the error text tells you the fix. **Trust the compiler here instead of
guessing**, and read the error rather than working around it.

One declaration serves as the migration's index spec, the query-time predicate factory, and the
baseline `DbTableCreator.verifySnapshotTableForAggregate` compares the database against — so a
queried index is necessarily a created one, and a drifted one is a detectable one. Do not
hand-write the extraction expressions.

The stored document has a type of its own: `SnapshotDocumentOf<TState>` (built from n-domain's
`SerializedValue`, no top-level `$typename`), with `toSnapshotDocument(aggregate)` as the one
sanctioned cast from `snapshot()`'s upstream `TState | object` union. `verifyDocument` takes it, and
the repositories' save/read paths go through it — the read-side meeting point with
`deserializeFromSnapshot` (typed upstream as taking the live state) is centralized in
`snapshotDocumentToState`, internal to `src/migration/snapshot-document.ts`.

The first save each process makes also verifies the declared paths against the real snapshot
document (`SnapshotQuerySet.verifyDocument`, run by the repositories through an internal guard): a
`@serialize("customKey")` rename — the one mismatch the types cannot see, since a decorator cannot
change a type — throws there rather than silently indexing null. A rename inside an *optional*
object can still slip past a process that never stores it; the total fix would be n-domain rejecting
renames on `DomainObject` getters, and until then assert
`MyRepository.indexes.verifyDocument(toSnapshotDocument(aggregate))` is empty in a test.

## Traps

Ordered roughly by how expensive they are to get wrong.

- **`querySet` override type.** Type it `typeof MyRepository.indexes`. The historical trap — the base
  declared `SnapshotQuerySet<TState, any, any>`, and repeating that widened type in the override
  compiled while silently discarding all path and cast checking — is now closed twice over: the base
  declares the method-free `DeclaredSnapshotQuerySet<TState>` (copying it means the override cannot
  build a single predicate), and the widened spelling is itself a compile error whose message names
  the fix. See the getter TSDoc in `src/repository/snapshot-base-repository.ts`.
- **A scope is a write boundary.** A scoped repository holds one transient `UnitOfWork`, and `save()`
  commits it. A committed unit of work is dead, so a second `save()` in the same scope throws
  `rolling back completed UnitOfWork`, which names neither cause nor fix. One scope per operation;
  use `saveWithin(value, unitOfWork)` to share a transaction. Lifetimes: `Db` singleton, `UnitOfWork`
  transient, repositories scoped.
- **`save` commits, `saveWithin` does not** — and `save` commits the shared unit of work *whole*,
  including anything another repository queued on it.
- **`getAll()` takes no arguments and reads everything.** It is not `getByIds([])`, which takes an
  array and returns nothing. Do not translate a v5 `getAll(...ids)` into `getAll(ids)`.
- **`DbMigrator` has a required call order.** Configure, then `await bootstrap()`, then
  `await runMigrations()` — the latter throws if bootstrap has not run. Supply *exactly one* of
  `useSystemTable(name)` or `registerDbVersionProvider(cls)`; both or neither throws.
  `useSystemTable` requires an all-lowercase name.
- **Migration version is parsed from the class name.** `ExDbMigration_1` *is* version 1: exactly one
  underscore, integer > 0 after it. **Renaming the class renumbers the migration.** Also,
  `registerMigrations` takes bare `Function`s, so nothing checks that a class implements
  `DbMigration`.
- **DDL is `if not exists`, matched on name alone.** The derived index name encodes paths and
  uniqueness but *not* `JsonValueType`. So adding a numeric cast to an already-indexed path silently
  keeps the old uncast index, and dropping `.asUnique()` never drops the `_uq` index. Nothing here
  alters or drops — that takes a hand-written migration.
- **Adding a path to a query set needs a *new* migration.** Migrations are versioned by class name
  and never re-run, so a path added after the table's migration ran compiles, queries, and
  sequential-scans forever. The re-run is cheap — `if not exists` creates only what is missing.
- **Drift never fails on its own — detect it.** `DbTableCreator.verifySnapshotTableForAggregate`
  (org and event-stream variants exist) takes the same arguments as the create call, touches
  nothing, and returns every declaration-vs-database divergence as `SnapshotDriftIssue`s — missing
  table/index (the message carries the fix DDL), cast/uniqueness/method/column mismatches (`fatal`,
  a migration is needed), orphan indexes (`advisory`, possibly deliberate). Run it at the tail of a
  migration run and throw on `fatal`, or assert it empty in an integration test — the same idiom as
  `verifyDocument`. The fix process is defined: fatal issues carry executable DDL in `fix`
  (advisories never do — an orphan may be deliberate); author the *next* migration, run the fixes
  (or drop what was flagged and re-call the create), and verify empty. Or call
  `reconcileSnapshotTableForAggregate` — **the one method in the API that drops anything** — which
  runs exactly the fatal fixes (each atomic, so a failed unique recreate leaves the old index
  standing) and returns `{ fixed, remaining }`; it never touches advisories and refuses to act on
  a missing table or `organization_id` column. Migration-time only: index builds block writes.
- **Expression indexes match textually.** A near-miss expression silently sequential-scans with no
  error. This is why expressions must come from the declaration.
- **`@inject` keys are fixed strings.** `"DbConnectionFactory"`, `"ReadDbConnectionFactory"`,
  `"CacheRedisClient"`, `"RedisClient"`, `"Logger"`. `KnexPgDb` and `KnexPgReadDb` take *different*
  keys despite the inheritance; the two Redis consumers take *different* keys for the same client
  type. See the Dependency Injection section of the README.
- **`InMemoryCacheService` does not check expiry on read.** `retrieve` never consults the eviction
  map; expiry happens on a 5-minute sweep. A short-TTL value still reads back. Do not write a TTL
  test against it and conclude the semantics are correct — verify against `RedisCacheService`.
- **Lock keys are trimmed and lowercased**, so case-distinct ids collide. `RedisCacheService` also
  prefixes cache keys with `bin_` while `InMemoryCacheService` does not.
- **`KnexPgDbConnectionFactory` sets `Pg.defaults.ssl` process-wide** — but only on the
  connection-string overload, not the `DbConnectionConfig` one.
- **`S3FileStore` holds the caller's config by reference** and mutates `idGenerator` into it. Do not
  share one config object across two stores.
- **`DistributedLockConfig.driftFactor` is inert.** It is declared, documented, validated and
  defaulted, but read nowhere. Do not reach for it to tune behavior.

## Build and test

- `yarn ts-build` — lint plus compile. Compilation is **in place**: `.js`/`.js.map` land beside every
  `.ts` in `src/` and `test/`. `dist/` is a separate second pass (`yarn ts-build-dist`).
- `dist/` is checked in and can lag `src/`. Never read it to learn the API — read `src/index.ts`.
- `yarn test` runs `node --test` over compiled `./test/**/*.test.js` and needs Postgres and Redis via
  `yarn setup-test-env`. Note the script ends in `|| true`, so **a failing suite still exits 0** —
  read the output, do not trust the exit code.
- `test-example/` is compiled and linted by the root config, so a change that breaks the example
  breaks the build. That is deliberate: it is where API friction shows up as a compile error rather
  than as an opinion. Keep it compiling.
