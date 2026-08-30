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
`serialize()`-bearer, even one with a structurally typed return, fails closed. So does
everything else the compiler cannot verify — no paths at all rather than unchecked ones (index signatures,
`any`/`unknown`, Map/Set, partially-serializable unions, and every `$`-prefixed key, `$typename`
included) — with `forRawPath` as the deliberate door. Several errors are phrased as instructions —
the *property name* in the error text tells you the fix. **Trust the compiler here instead of
guessing**, and read the error rather than working around it.

**One caveat, and it is the exception to "fails closed".** `DomainObjectSerialized` maps over the
class's declared `TDataKeys`, not over its `@serialize` decorators, and the runtime serializer walks
the decorators. So the two sets can differ, and when they do the extra keys are *written to every row*
while offering no path — closed on the path side, open on the storage side. No runtime check closes
it either: `verifyDocument` verifies that declared paths resolve, never that stored keys are declared.
Decorating a getter is therefore **not** sufficient to make its path declarable; listing it in
`TDataKeys` is what does that. See the trap below.

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
- **A save of an unchanged aggregate does nothing; `force` is the migration door.** The **snapshot**
  repositories' `save(value, force)` / `saveWithin(value, unitOfWork, force)` skip the
  `!isNew && !hasChanges` check so a row can be re-serialized — the case being a newly `@serialize`d
  computed field that rows written earlier do not carry. It skips that check and nothing else: the
  event stream keeps its own, so no events are appended and no `onSave` fires, and forcing it there
  instead would build an empty `values ;` list. Not on `Repository<T>` (the event stream repositories
  implement it and cannot honor it), so it is unreachable through a domain interface — resolve the
  concrete snapshot repository. On an org repository the tenant check still applies: one pass per
  organization's domain context.
- **`getAll()` takes no arguments and reads everything.** It is not `getByIds([])`, which takes an
  array and returns nothing. Do not translate a v5 `getAll(...ids)` into `getAll(ids)`.
- **`get`/`getByIds` take no predicate; `queryById`/`queryByIds` do.** An id lookup filtered by a
  declared path is the one composition a `SnapshotQuerySet` cannot express — `id` is a column beside
  `data`, so no predicate reaches it. That pair is where the two meet, and it is `protected` on
  purpose: a predicate is publicly constructible (the migration consumes the same `indexes` static a
  repository exposes), so an optional predicate on the public `get` would let any caller filter these
  reads. Note `queryById` returns `null` rather than throwing, for a missing id and an excluded one
  alike — unlike `get`, which throws `AggregateNotFoundException`. On an org repository the pair has
  cross-tenant counterparts, `queryByIdAcrossOrganizations`/`queryByIdsAcrossOrganizations` — the same
  statement with the organization filter dropped, also `protected`, also returning `null`/`[]` on a
  miss. What they return is read-only in practice: `save` rejects an aggregate whose organization is
  not the current one, so a cross-tenant read cannot become a cross-tenant write.
- **Crossing the tenant boundary keeps the index only for an id or an array.** Every btree expression
  index on an org snapshot table leads with `organization_id`, and btree serves only a leading prefix
  — so a *cross-organization* predicate on a declared path cannot use its index and sequentially
  scans, however exactly the expression matches. Two reads survive the crossing intact: a lookup by
  `id`, served by the primary key, which has no tenant prefix; and array containment, served by a GIN
  index, which cannot have one. This is why the cross-organization surface is an id pair plus a raw
  statement door, and not a general typed predicate — prefer `queryByIdAcrossOrganizations` and reach
  for `queryAcrossOrganizations` knowing what it costs.
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
- **A `@serialize`d getter left out of `TDataKeys` is stored but undeclarable, and nothing tells
  you.** The serializer walks decorators, so the key is in every row; the path types walk
  `DomainObjectSerialized` over `TDataKeys`, so `withPath` on it is a compile error; and
  `verifyDocument` only checks declared→resolves, never stored→declared. This is how a *materialized*
  derived value — one deliberately stored so it can be indexed and compared, which is the only way to
  ask how many elements an array holds, since GIN containment answers membership and carries nothing
  about length — silently becomes dead weight. List it in `TDataKeys`, and derive it at the `super()`
  call rather than accepting it: `Schema<T, K>` makes every data key required, so taking
  `DomainObjectData<T>` whole would oblige callers to pass a value the constructor ignores and that
  can disagree with what it is derived from. Two costs are inherent: rows written before the getter
  existed carry no key, so the index reads null for them until each aggregate is saved again; and a
  row written under an older rule keeps that rule's value while the object rebuilt from it recomputes,
  so index and object disagree until a re-save. `StudioPlan` and `ExDbMigration_3` in `test-example/`
  are the worked pair — and note it compounds with the next trap, since the new path also needs a
  migration.
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
