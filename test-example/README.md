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
| `serialization.test.ts` | no | every `@serialize`d class round-trips, through events *and* through a snapshot |
| `example.test.ts` | **yes** | migrations, the DDL and indexes, the organization filter, the unique constraints, and the unit of work |

The split matters. `serialization.test.ts` is the one that catches the most damaging class of mistake: a
serialized key that does not match a constructor parameter arrives as `undefined` and trips a guard at *read*
time, long after the write that caused it. It costs nothing to run and it is where that shows up.

`example.test.ts` runs its blocks in order and shares state deliberately — it is one application session, not
a set of isolated units.

## Three things worth knowing before reading the code

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

**One declaration, two consumers.** Each snapshot repository declares a `SnapshotQuerySet` as a static, the
migration creates the table's indexes from that same object, and every predicate in the repository is built by
it. That is what makes an index that is queried necessarily one that was created — and what makes
`this.querySet.eq("slug", …)` reject a path the repository never declared, or a value of the wrong type for the
leaf it names.
