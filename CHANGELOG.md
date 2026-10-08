# Changelog

All notable changes to `@nivinjoseph/n-data` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This file starts at the 7.x line. Git tags stop at `v4.0.1` while `package.json` had already reached
`7.0.3`, so the entries below were reconstructed from commit history and from the README's own
"Breaking changes in v8" list; anything a commit subject did not record is not guessed at here.
Releases before 7.0.0 live in git history only.

## [Unreleased]

This is the **v8** line. No reindexing and no data migration: every index and every emitted statement
is byte-identical to v7's — unless a path is declared `acrossOrganizations`, which creates one new index
per flagged path and needs a migration to do so.

### Changed

- **Breaking:** `ReadModelRepository<T>` gains `saveAll(models)` and `saveAllWithin(models, unitOfWork)`.
  A hand-written implementor — an in-memory test double of a domain interface extending it — must add
  both; a class extending `ReadModelBaseRepository` inherits them.
- **Breaking:** n-domain 4.0.3 is required, and nested typed paths follow it exclusively. Typed paths,
  array paths and containment element shapes come from `DomainObjectSerialized`, offered only for real
  n-domain `DomainObject`/`DomainEntity` members. A state member typed as a bare or custom
  `Serializable` — even with a structurally typed `serialize()` — no longer offers nested paths:
  convert it to a `DomainObject`, or go through `forRawPath`.
- **Breaking:** `$`-prefixed keys are excluded from every typed surface — paths, array paths and
  `contains` match keys. (n-domain 4.0.2 put `$typename` into the serialized *type*, which would
  otherwise offer paths the segment validation rejects at runtime.) The raw doors are unchanged, and a
  `containmentForRawPath` match document still takes `$typename`.
- **Breaking:** `verifyDocument` takes `SnapshotDocumentOf<TState>`. Replace
  `verifyDocument(aggregate.snapshot() as object)` with `verifyDocument(toSnapshotDocument(aggregate))`.
- **Breaking:** `containmentForRawPath` no longer defaults `TElement` to `any`. The default is `never`,
  under which no match document can be built — supply the stored element shape, or write
  `containmentForRawPath<any>(path)` to keep the old unchecked behavior explicitly.
- **Breaking:** a declaration path must be an inline literal. `withPath(someVariable)` — a variable
  typed as the path union — used to compile and silently widen the declared-path record to every state
  path, discarding path and cast checking; it is a compile error now, as is a widened spec array or
  member in `withComposite` and a widened `withArrayPath` argument. Inline literals are unaffected. A
  genuinely computed key goes through `SnapshotIndex.forRawPath`, as before.
- **Breaking (types only):** org snapshot reads are now typed under the correct org state type; they
  were typed under the bare `AggregateState`. No behavioral change.
- `SnapshotTableInfo.createdIndexes` now includes the standalone `(organization_id)` index the org
  create adds when no btree declaration covers that column — reported with empty `paths` and the
  column as `leadingColumn`. It was created but unreported before, so a test doing `deepStrictEqual`
  on `createdIndexes` for such a table will see the extra entry.
- **Breaking:** `OrgSnapshotBaseRepository.queryAcrossOrganizations` is now the *typed*
  cross-organization door, taking a `SnapshotPredicate<true>` or `RepositoryQuery<true>`; the raw
  statement door it used to be is `queryStatementAcrossOrganizations(sql, ...params)`, unchanged in
  behavior. Rename call sites.
- **Breaking:** `SnapshotPredicate` and `SnapshotOrderBy` carry a required `acrossOrganizations: boolean`
  brand and are generic over it (default `boolean`, so an annotation naming no brand keeps compiling);
  `RepositoryQuery` is generic the same way, and `DeclaredSnapshotQuerySet` gains
  `acrossOrganizationsPaths`. A hand-built `{ sql, params }` literal no longer satisfies
  `SnapshotPredicate` — build it through `raw` or `rawAcrossOrganizations`.

### Added

- **Batch writes on read model repositories.** `saveAll`/`saveAllWithin` write a batch as one
  multi-row `insert ... on conflict (id) do update` per chunk of up to 500 rows (fewer for a wide
  table: Postgres binds at most 65535 parameters per statement), so a re-projection costs one round
  trip per chunk rather than per row. The whole batch is checked before anything is queued and a bad
  row is named by position and id; a batch may not repeat an id; the rows go out sorted by id so
  concurrent batches lock in one order. `ReadModelShapeGuard.adviseOnce` replaces `verify`
  (internal).
- **Read models.** A flat, `DomainEntity`-shaped projection — `ReadModel<TThis, TDataKeys>`, an `id`
  plus scalar or array-of-scalar properties — stored one row per instance in a table with one real
  typed column per property, so any analytical SQL runs against it. Declared once by
  `ReadModelSchema.for(Model, { key: { type: ColumnType.x, index?, unique?, name? } }).withIndex([...])`:
  an object literal keyed by every data key, so completeness, type fit, flatness and `unique` on an
  array are compile errors, and every predicate checks its key and value against the declaration;
  every consumer takes `IntactReadModelSchema<T>`, so a schema widened to `ReadModelSchema<any>` is
  refused where it is handed over. Consumed by `ReadModelTableCreator` (`createReadModelTable`, `verifyReadModelTable` with
  `ReadModelDriftIssue`, `reconcileReadModelTable`) and by `ReadModelBaseRepository`
  (`get`/`getByIds`/`getAll`, the upsert `save`/`saveWithin`, `delete`/`deleteWithin`, and the protected `query`/`queryById`/`queryByIds`/`exists`/`count`/`queryRaw`/`queryStatement` doors, with
  `ReadModelQuery` for ordering and paging). Predicates: `eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`,
  `isNull`/`isNotNull` on any column, `like`/`ilike` on text, `contains`/`containsAll`/`containsAny`
  over array columns (GIN-served `@>`/`&&`), `and`/`or`/`not`/`raw`, `orderBy`, `columnFor`.
  `ColumnType.timestamptz` stores a number of epoch milliseconds as a real timestamp. Every column
  is nullable, every save is an upsert, and there is no organization-scoped variant — a read model is
  cross-organization by design. `verifyModel` is `verifyValues` (every value against its column's type and
  Postgres range, run on every save) plus `verifyShape` (the `undeclared-getter`, `undecorated-getter`
  and `renamed-getter` advisories, read from the class's metadata and logged once per schema);
  hydration stamps the class's registered `$typename` as the deserializer does. `verifyReadModelTable`
  also reports `index-definition-mismatch` for a partial index, opclass or ordering under a declared
  name. `DataHelper.createReadModelTableName`, present since 7.0 with no callers, now takes a read
  model class (`ReadModelClass`) and no longer takes a prefix. Internal:
  `RepositoryQueryBuilder.buildSelect` parameterizes the select list (`build` delegates to it with
  `data`, byte-identical) and the builders are overloaded per predicate family; the DDL helpers and
  the index-comparison skeleton both creators share moved to `src/migration/table-ddl.ts`. `test-example/` gains `CreatorActivity`, a cross-studio projection,
  and `ExDbMigration_5`.
- **Typed, index-served cross-organization reads.** `withPath`/`withComposite` take
  `acrossOrganizations: true` on an org-scoped state (refused on a plain one, at compile time and at
  plan time). `DbTableCreator.createSnapshotTableForOrgAggregate` then creates the path's
  `(organization_id, expr)` index *and* a prefix-free twin named `idx_<table>_<suffix>_xorg` (never
  unique), reported in `createdIndexes` with no `leadingColumn`, expected by
  `verifySnapshotTableForOrgAggregate` (a missing twin is a fatal `index-missing` carrying its DDL; a
  leftover one after clearing the flag is an advisory orphan) and created by
  `reconcileSnapshotTableForOrgAggregate`. Every predicate and order-by term is branded by the paths it
  reads — `SnapshotPredicate<true>` when all are flagged, containment always, `and`/`or` when every arm
  is, `rawAcrossOrganizations` by the caller's claim — and `OrgSnapshotBaseRepository` gains
  `queryAcrossOrganizations(predicate | query)`, `existsAcrossOrganizations` and
  `countAcrossOrganizations`, which accept only that brand, at compile time and, for JavaScript
  callers, at runtime. `SnapshotIndex` gains `acrossOrganizations()`/`isAcrossOrganizations`;
  `SnapshotQuerySet` gains `rawAcrossOrganizations` and `acrossOrganizationsPaths`. Planner-tested: a
  flagged path's cross-org predicate is an index lookup on the twin (2 index pages touched), where the
  same read on an unflagged path walks the whole org-leading index (22 of 23 pages) or scans the table.
  `test-example/` carries the worked pair: `email` flagged on `SnapshotCreatorRepository`,
  `ExDbMigration_4` creating the twin, `queryAcrossStudiosByEmail` through the typed door.

- **`force` on the snapshot repositories' save doors.** `save(value, force)` and
  `saveWithin(value, unitOfWork, force)` on `SnapshotBaseRepository` and `OrgSnapshotBaseRepository`
  take an optional `force` (default `false`) that writes the snapshot row even when the aggregate is
  neither new nor changed. This is the data-migration case: a newly `@serialize`d computed field,
  declared on the query set and indexed by a migration, is absent from every row written before it
  existed, and an aggregate loaded and saved back untouched would otherwise be a no-op. It bypasses
  that one check and nothing else - the event stream keeps its own, so no events are appended and no
  `onSave` fires, and the write is the same `on conflict (id) do update` upsert an ordinary update
  takes. On an org repository the tenant check is unmoved, so a migration covering every tenant runs
  once per organization's domain context. Deliberately **not** on `Repository<T>`: the event stream
  repositories implement that interface and an unchanged aggregate gives them no events to append, so
  `force` is reachable only through a snapshot repository's own type.
- `id` is queryable.
- **Cross-organization lookup by id on `OrgSnapshotBaseRepository`.** `queryByIdAcrossOrganizations(id,
  predicate?)` and `queryByIdsAcrossOrganizations(ids, predicate?)` are `queryById`/`queryByIds` with
  the organization filter dropped - the read a platform-wide question needs ("which organization owns
  this id?"), which previously meant hand-writing a statement through what is now
  `queryStatementAcrossOrganizations` and,
  for a list, hand-building the `in (?, ?, ...)` placeholder run. They keep the same id hygiene and the
  same null-on-miss contract, and they are `protected`, so crossing the boundary is still a method a
  subclass names for itself rather than something the public surface offers. Cheap where a
  cross-organization condition on a declared path is not: `id` is the primary key, the one index on an
  org snapshot table with no leading `organization_id`, so this stays an index lookup while a path
  predicate without the tenant filter cannot use its index at all - unless the path is declared
  `acrossOrganizations`, below. What comes back is read-only in
  practice - `save` still rejects an aggregate belonging to another organization.
- **Documentation: the materialized-derived-value rule.** A `@serialize`d getter left out of a
  `DomainObject`'s `TDataKeys` is written to every row — the runtime serializer walks decorators —
  while offering no typed path, and `verifyDocument` cannot flag it, since it checks that declared
  paths resolve and never that stored keys are declared. It is the one place this API is closed on the
  path side and open on the storage side, so it is now stated in `AGENTS.md` (both in "Where the
  compiler already protects you" and as a trap) and in the README beside the stored-shape bullet,
  with the derive-at-`super()` constructor idiom shown as code. `test-example/` carries the worked
  pair: `StudioPlan.featureCount` declared, indexed via `ExDbMigration_3`, read by
  `getByMinPlanFeatures`, and a test pinning that a stale stored count cannot reach the object.

## [7.0.3] - 2026-08-16

### Changed

- n-domain upgraded to 4.0.3, with regression tests (#20). An array data member on a `DomainObject` is
  constructible as of that version, which is what makes a nested array path such as `plan.features`
  reachable in practice.
- Stored file refactorings.

## [7.0.2] - 2026-08-16

### Added

- Snapshot drift detection — `DbTableCreator.verifySnapshotTableForAggregate` and its org and
  event-stream variants, returning every declaration-vs-database divergence as `SnapshotDriftIssue`s.
- Snapshot table reconcile — `reconcileSnapshotTableForAggregate`, which runs the fatal drift fixes.

### Changed

- Adjusted to n-domain's serialization tightening.

## [7.0.1] - 2026-08-15

Publish only; no recorded changes.

## [7.0.0] - 2026-08-15

### Changed

- **Breaking:** snapshot indexing and querying are strongly typed against the serialized shape,
  leveraging n-domain's new domain object base class for snapshots (#19).
- n-domain updated.
