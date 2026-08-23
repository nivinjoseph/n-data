# Changelog

All notable changes to `@nivinjoseph/n-data` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This file starts at the 7.x line. Git tags stop at `v4.0.1` while `package.json` had already reached
`7.0.3`, so the entries below were reconstructed from commit history and from the README's own
"Breaking changes in v8" list; anything a commit subject did not record is not guessed at here.
Releases before 7.0.0 live in git history only.

## [Unreleased]

This is the **v8** line. No reindexing and no data migration: every index and every emitted statement
is byte-identical to v7's.

### Changed

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

### Added

- `id` is queryable.
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
