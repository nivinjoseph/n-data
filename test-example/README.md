# `test-example/` — a worked DDD application on n-data

A small but complete application built on this library, existing for one reason: **to be the place API
friction shows up as a compile error or a failing test rather than as an opinion.**

The library's own suite in `test/` cannot do that. Every aggregate there is an empty stub — declared, never
instantiated, used only so a table name can be derived. Nothing in this repository had ever constructed a real
aggregate, replayed one from its event stream, or registered a repository with n-ject until this folder
existed.

It is compiled and linted by the root `tsconfig.json` and `eslint.config.js` along with everything else, which
is deliberate: if the example stops compiling, `yarn ts-build` fails. That is what stops it rotting the way a
prose example does.

## The domain

Two aggregates, chosen so that both halves of the library get exercised:

- **`Studio`** — a plain `AggregateRoot`, and the tenant. A studio's id *is* the `organizationId` every
  creator is scoped by, which is why the multi-tenant boundary is itself a non-org aggregate: the boundary
  cannot sit inside a boundary.
- **`Creator`** — an `OrgAggregateRoot`. Someone who works within one studio.

## Running it

```bash
# Postgres, plus the example's own database
yarn setup-db-server
yarn setup-db              # testdb, for the library suite
yarn setup-example-db      # exdb, for this example

yarn ts-build              # compiles and lints src, test and test-example
yarn test-example
```

`exdb` is its own database on purpose. The migrator records the schema version in one system table per
database, so two migrators sharing a database would fight over the same counter — hence one migrator per
database, and hence a database of our own rather than sharing `testdb`.

## Layout

The per-aggregate slice, mirroring the convention in the application this was modelled on:

```
studio/
  studio.ts                     the aggregate root — no constructor, @serialize on the class
  studio-state.ts               the state interface and its AggregateStateFactory
  value-objects/                DomainObject implementations
  events/studio-event.ts        the abstract base carrying refType
  events/*.ts                   one class per event
  exceptions/                   this aggregate's domain exceptions
  factories/                    the factory interface and its default implementation
  repositories/                 the interface, plus an event-stream and a snapshot implementation
  ioc/                          the domain installer
db-migration/
  ex-db-migrator.ts             one migrator, named for the database it owns
  migrations/ex-db-migration_1.ts
  migrations/ex-db-migration_2.ts
  migrations/ex-db-migration_3.ts
  migrations/ex-db-migration_4.ts
test/                           the doubles and the tests
```

Migrations are named for the **database**, not the feature. `DbMigrator` parses the version off the class
name — exactly one underscore, integer suffix greater than zero — so `ExDbMigration_1` *is* version 1 of
`exdb`. Renaming the class renumbers the migration.

## What each test file is for

| file | needs Postgres | what it establishes |
| --- | --- | --- |
| `studio.test.ts` | no | Studio's behavior and invariants, through the factory and an in-memory repository |
| `creator.test.ts` | no | the same for Creator, including that a natural key is per-tenant |
| `serialization.test.ts` | no | every `@serialize`d class round-trips, through events *and* through a snapshot; every declared index path resolves in a real snapshot (`verifyDocument`); and a materialized derived value is recomputed on read rather than trusted, so a stale stored count cannot reach the object |
| `example.test.ts` | **yes** | migrations, the DDL and indexes, drift verification (`verifySnapshotTableForAggregate` asserts empty against the same declarations), the organization filter, the unique constraints, an id lookup composed with a declared path (`queryById`/`queryByIds`, including that an archived studio is excluded while `get` still returns it), both ways out of the tenant boundary (the typed `queryAcrossOrganizations` by `email`, a path declared across organizations - including that an unflagged path such as `role` is a compile error there - and `queryByIdAcrossOrganizations` by id, including that an id owned by another studio is still a miss for `get`, and that what the cross-tenant read returns cannot be saved from the reading studio), and the unit of work |

The split matters. `serialization.test.ts` is the one that catches the most damaging class of mistake: a
serialized key that does not match a constructor parameter arrives as `undefined` and trips a guard at *read*
time, long after the write that caused it. It costs nothing to run and it is where that shows up.

`example.test.ts` runs its blocks in order and shares state deliberately — it is one application session, not
a set of isolated units.

## Four things worth knowing before reading the code

**A scope is a write boundary.** A repository is registered `scoped` and takes its unit of work by injection,
so one repository instance holds exactly one; `save` with no explicit unit of work commits it, and a committed
unit of work is dead. So a second `save` in the same scope fails from inside the repository with
`rolling back completed UnitOfWork`. One scope per operation is the model — which a web application gets for
free by scoping per request. Two writes that must share a transaction take an explicit `UnitOfWork` instead;
`example.test.ts` does both.

**Disposal is slow by design.** `KnexPgDbConnectionFactory.dispose` waits a fixed 15 seconds before destroying
the pool. The driver therefore disposes its migrators and its container *concurrently* at the end rather than
inline, so the suite pays that once instead of once per pool. A process that migrates at startup pays the same
15 seconds on its boot.

**One declaration, three consumers.** Each snapshot repository declares a `SnapshotQuerySet` as a static, the
migration creates the table's indexes from that same object, every predicate in the repository is built by
it — and `example.test.ts` hands it to `verifySnapshotTableForAggregate`, which compares the real database
against it and asserts no drift. That is what makes an index that is queried necessarily one that was
created — and, since declarations change after migrations have run, what makes a drifted one detectable. It is
also what makes `this.querySet.eq("slug", …)` reject a path the repository never declared, or a value of the
wrong type for the leaf it names. The one mismatch the types cannot see — a `@serialize("customKey")` rename,
which stores under the custom key while the type offers the getter name — is covered twice at runtime: the
repositories verify the declared paths against the first document each process saves, and
`serialization.test.ts` asserts `SnapshotStudioRepository.indexes.verifyDocument(toSnapshotDocument(studio))`
is empty, which also catches a rename hiding inside an optional member production might not store for a while.

**A derived getter is a storage decision.** `StudioPlan` carries one of each kind, and the difference is not
about the domain. `isUnlimited` is undecorated: absent from storage, recomputed on every read, so the rule
behind it can change without rewriting history — and it is unqueryable, because there is nothing stored to
index. `featureCount` is `@serialize`d: written into the jsonb as its own leaf, so it can be indexed and
compared. That buys the one question the GIN index over `plan.features` cannot answer — containment tests
membership and carries nothing about length — which is why `getByMinPlanFeatures` exists alongside
`getByPlanFeature`.

Materializing one has a rule and a cost. The rule: it must appear in the class's `TDataKeys`. A decorated
getter left out is written to every row regardless, because the runtime serializer walks decorators while the
path types walk `DomainObjectSerialized` over `TDataKeys` alone — so the value is stored, `withPath` on it is
a compile error, and `verifyDocument` cannot flag it either, since it checks that declared paths resolve and
never that stored keys are declared. `StudioPlan` keeps the constructor honest anyway by deriving the value at
its `super()` call, because listing a key makes it *required* input and no caller should be passing a count it
cannot get wrong. The cost: a stored derivation is a fact about when it was written. Rows older than the getter
carry no key at all, so the index reads null for them until each aggregate is saved again; and a row written
under an older rule keeps that rule's number while the object rebuilt from it recomputes and is correct — so
the index and the object disagree until a re-save. `serialization.test.ts` pins that last property directly,
by tampering with a stored count and asserting the reconstructed plan ignores it.

Adding the path also needed `ExDbMigration_3`. A migration never re-runs, so a path declared after the
table's migration has run compiles, builds a predicate, and sequential-scans forever — which is why the third
migration simply re-calls `createSnapshotTableForAggregate` with the current declaration and lets
`if not exists` create only what is missing.

`ExDbMigration_4` is the same idiom for a different change: `email` was declared `acrossOrganizations` after
`_2` had run, and the flag *is* an index — the prefix-free `idx_creator_snaps_email_xorg` twin that the typed
cross-studio read walks — so it too needs a migration that re-calls the create. Flagging a path is adding an
index, and the drift check reports the missing twin exactly as it reports a missing path.
