import { OrgConfigurableDomainContext } from "@nivinjoseph/n-domain";
import { Container, Scope } from "@nivinjoseph/n-ject";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { Db, DbException, DbMigrator, KnexPgDbConnectionFactory, KnexPgUnitOfWork, UnitOfWork } from "../../src/index.js";
import { ExampleLogger } from "../common/example-logger.js";
import { CommonInstaller } from "../common/ioc/common-installer.js";
import { CreatorFactory } from "../creator/factories/creator-factory.js";
import { CreatorEmailUnavailableException } from "../creator/exceptions/creator-email-unavailable-exception.js";
import { CreatorDomainInstaller } from "../creator/ioc/creator-domain-installer.js";
import { Creator } from "../creator/creator.js";
import { CreatorRepository } from "../creator/repositories/creator-repository.js";
import { EventStreamCreatorRepository } from "../creator/repositories/event-stream-creator-repository.js";
import { SnapshotCreatorRepository } from "../creator/repositories/snapshot-creator-repository.js";
import { SnapshotStudioRepository } from "../studio/repositories/snapshot-studio-repository.js";
import { createExDbMigrator } from "../db-migration/ex-db-migrator.js";
import { StudioFactory } from "../studio/factories/studio-factory.js";
import { StudioSlugUnavailableException } from "../studio/exceptions/studio-slug-unavailable-exception.js";
import { StudioDomainInstaller } from "../studio/ioc/studio-domain-installer.js";
import { EventStreamStudioRepository } from "../studio/repositories/event-stream-studio-repository.js";
import { StudioRepository } from "../studio/repositories/studio-repository.js";
import { StudioPlan } from "../studio/value-objects/studio-plan.js";

/**
 * The end-to-end driver: migrations, then the two aggregates through their real repositories against a real
 * Postgres.
 *
 * The blocks run in order and share state deliberately - this is one application session, not a set of
 * isolated units. The domain layer is covered without a database in `studio.test.ts`, `creator.test.ts` and
 * `serialization.test.ts`; what is only checkable here is everything the library actually does: the DDL, the
 * indexes, the organization filter, the unique constraints, and the unit of work.
 */
await describe("The example application", async () =>
{
    const logger = new ExampleLogger();

    // one process-wide mutable context, as the shared installer registers it. The organization is set as the
    // driver moves between studios, which is exactly what a real per-request context would do per request -
    // and a reminder that a *shared* mutable context is only safe because nothing here is concurrent.
    const domainContext = new OrgConfigurableDomainContext("tester", "std_bootstrap0000000000000000000");

    let container: Container;
    let db: Db;

    /**
     * Migrators are disposed together at the end rather than inline.
     *
     * `KnexPgDbConnectionFactory.dispose` waits a fixed 15 seconds before destroying the pool, and each
     * container disposes its own registrations - so a migrator disposed inside a test costs 15 seconds, and
     * two of them cost 30. Disposed concurrently in `after`, all the delays overlap and the suite pays it
     * once. Worth knowing for a process that migrates at startup: the same delay lands on its boot time.
     */
    const migrators = new Array<DbMigrator>();

    let studioAId: string;
    let studioBId: string;

    function createScope(): Scope
    {
        return container.createScope();
    }

    /**
     * Runs one operation in its own scope.
     *
     * A scope is not just a resolution boundary here, it is a **write** boundary. A repository is scoped and
     * takes its unit of work by injection, so one repository instance holds exactly one - and `save` with no
     * explicit unit of work commits that one. A committed unit of work is dead: every method on it throws
     * afterwards. So a second `save` in the same scope fails from inside the repository with
     * "rolling back completed UnitOfWork", which names neither the cause nor the fix.
     *
     * One scope per operation is therefore the model, and it is what a web application gets for free by
     * scoping per request. Two writes that must share a transaction take an explicit unit of work instead -
     * see the last block.
     */
    async function inScope<T>(action: (scope: Scope) => Promise<T>): Promise<T>
    {
        const scope = createScope();

        try
        {
            return await action(scope);
        }
        finally
        {
            await scope.dispose();
        }
    }

    before(async () =>
    {
        container = new Container();
        // shared infrastructure once, then one installer per aggregate - the composition stays flat, because
        // n-ject throws on a duplicate key
        container.install(new CommonInstaller(domainContext, logger));
        container.install(new StudioDomainInstaller());
        container.install(new CreatorDomainInstaller());
        await container.bootstrap();

        // the raw handle used for the DDL and index assertions below rides the container's pool rather than a
        // second one, so there is only one pool to pay for at teardown
        db = container.resolve<Db>("Db");

        await db.executeCommand(`
            drop table if exists creator_snaps;
            drop table if exists creator_events;
            drop table if exists studio_snaps;
            drop table if exists studio_events;
            drop table if exists ex_db_system;
        `);
    });

    after(async () =>
    {
        // concurrently, so the pools' fixed disposal delays overlap
        await Promise.all([...migrators.map(t => t.dispose()), container.dispose()]);
    });

    await describe("Migrations", async () =>
    {
        await test("run in order and create both aggregates' tables", async () =>
        {
            const migrator = createExDbMigrator(domainContext, logger);
            migrators.push(migrator);

            await migrator.bootstrap();
            await migrator.runMigrations();

            const tables = await db.executeQuery<{ table_name: string; }>(
                `select table_name from information_schema.tables where table_schema = 'public';`);
            const names = tables.rows.map(t => t.table_name);

            assert.ok(names.contains("studio_events"), names.join(", "));
            assert.ok(names.contains("studio_snaps"), names.join(", "));
            assert.ok(names.contains("creator_events"), names.join(", "));
            assert.ok(names.contains("creator_snaps"), names.join(", "));

            // useSystemTable opted into the built-in version provider, which created this lazily
            assert.ok(names.contains("ex_db_system"), names.join(", "));
        });

        await test("record version 2, one per migration", async () =>
        {
            const result = await db.executeQuery<{ data: { version: number; }; }>(
                `select data from ex_db_system where key = 'db_info';`);

            assert.strictEqual(result.rows[0].data.version, 2);
        });

        await test("create every index the repositories declared", async () =>
        {
            const result = await db.executeQuery<{ indexname: string; }>(
                `select indexname from pg_indexes where schemaname = 'public';`);
            const names = result.rows.map(t => t.indexname);

            // the studio side: a unique natural key, the cast numerics, the nested path, the GIN array
            assert.ok(names.contains("idx_studio_snaps_slug_uq"), names.join(", "));
            assert.ok(names.contains("idx_studio_snaps_plan_tier"), names.join(", "));
            assert.ok(names.contains("idx_studio_snaps_plan_seatlimit"), names.join(", "));
            assert.ok(names.contains("idx_studio_snaps_creatorcount"), names.join(", "));
            assert.ok(names.contains("idx_studio_snaps_tags_gin"), names.join(", "));

            // and the creator side, whose btree indexes all lead with organization_id
            assert.ok(names.contains("idx_creator_snaps_email_uq"), names.join(", "));
            assert.ok(names.contains("idx_creator_snaps_role_displayname"), names.join(", "));
            assert.ok(names.contains("idx_creator_snaps_skills_gin"), names.join(", "));
        });

        await test("are idempotent - a second run reports nothing to do", async () =>
        {
            logger.clear();

            const migrator = createExDbMigrator(domainContext, logger);
            migrators.push(migrator);

            await migrator.bootstrap();
            await migrator.runMigrations();

            assert.ok(logger.entries.some(t => t.contains("No migrations to execute")),
                logger.entries.join("\n"));

            const result = await db.executeQuery<{ data: { version: number; }; }>(
                `select data from ex_db_system where key = 'db_info';`);
            assert.strictEqual(result.rows[0].data.version, 2);
        });
    });

    await describe("Studio, through its factory and repository", async () =>
    {
        await test("creating a studio writes the snapshot and the event stream", async () =>
        {
            const scope = createScope();

            try
            {
                studioAId = await scope.resolve<StudioFactory>("StudioFactory")
                    .create("Bright Forge", "studio", 10);

                const studio = await scope.resolve<StudioRepository>("StudioRepository").get(studioAId);

                assert.strictEqual(studio.slug, "bright-forge");
                assert.strictEqual(studio.version, 1);
            }
            finally
            {
                await scope.dispose();
            }

            // both tables were written by the one save - the snapshot repository writes through to the stream
            const snaps = await db.executeQuery<{ count: number; }>(
                `select cast(count(*) as int) as count from studio_snaps where id = ?;`, studioAId);
            const events = await db.executeQuery<{ count: number; }>(
                `select cast(count(*) as int) as count from studio_events where aggregate_id = ?;`, studioAId);

            assert.strictEqual(snaps.rows[0].count, 1);
            assert.strictEqual(events.rows[0].count, 1);
        });

        await test("mutating and saving appends events and replaces the snapshot", async () =>
        {
            const scope = createScope();

            try
            {
                const repository = scope.resolve<StudioRepository>("StudioRepository");
                const studio = await repository.get(studioAId);

                await studio.rename("Forge Works", repository);
                studio.addTag("animation");
                studio.addTag("vfx");
                studio.changePlan(new StudioPlan({ tier: "enterprise", seatLimit: 0 }));
                studio.setCreatorCount(2);

                assert.strictEqual(studio.hasChanges, true);

                await repository.save(studio);
            }
            finally
            {
                await scope.dispose();
            }

            const snaps = await db.executeQuery<{ count: number; }>(
                `select cast(count(*) as int) as count from studio_snaps where id = ?;`, studioAId);
            const events = await db.executeQuery<{ count: number; }>(
                `select cast(count(*) as int) as count from studio_events where aggregate_id = ?;`, studioAId);

            // one snapshot row, upserted; six events, appended
            assert.strictEqual(snaps.rows[0].count, 1);
            assert.strictEqual(events.rows[0].count, 6);
        });

        // the claim that matters most: the two storage paths must agree, which is the real test of the
        // @serialize round trip through a database rather than through memory
        await test("the event stream and the snapshot reconstruct the same studio", async () =>
        {
            const scope = createScope();

            try
            {
                const fromSnapshot = await scope.resolve<StudioRepository>("StudioRepository").get(studioAId);
                const fromEvents = await scope.resolve<EventStreamStudioRepository>(
                    "EventStreamStudioRepository").get(studioAId);

                assert.strictEqual(fromEvents.version, fromSnapshot.version);
                assert.strictEqual(fromEvents.name, fromSnapshot.name);
                assert.strictEqual(fromEvents.slug, fromSnapshot.slug);
                assert.strictEqual(fromEvents.creatorCount, fromSnapshot.creatorCount);
                assert.deepStrictEqual([...fromEvents.tags], [...fromSnapshot.tags]);
                assert.ok(fromEvents.plan instanceof StudioPlan);
                assert.deepStrictEqual(fromEvents.snapshot(), fromSnapshot.snapshot());
            }
            finally
            {
                await scope.dispose();
            }
        });

        await test("a duplicate slug is refused by the domain and by the database", async () =>
        {
            const scope = createScope();

            try
            {
                const factory = scope.resolve<StudioFactory>("StudioFactory");

                // the domain path: the factory probes before creating and raises a precise error
                await assert.rejects(
                    () => factory.create("Forge   Works", "free", 3),
                    StudioSlugUnavailableException);

                studioBId = await factory.create("Night Owl Studio", "free", 3);
            }
            finally
            {
                await scope.dispose();
            }

            // the database path: the unique index is the backstop the probe cannot provide under a race.
            // Postgres reports 23505, which is what a real exception handler discriminates on.
            await assert.rejects(
                () => db.executeCommand(
                    `insert into studio_snaps (id, data) values (?, ?);`,
                    "std_260810duplicateduplicatedup", JSON.stringify({ id: "x", slug: "forge-works" })),
                (e: unknown) =>
                {
                    assert.ok(e instanceof DbException);
                    assert.strictEqual((e.innerException as { code?: string; }).code, "23505");

                    return true;
                });
        });

        await test("indexed reads answer the domain's questions", async () =>
        {
            const scope = createScope();

            try
            {
                const repository = scope.resolve<StudioRepository>("StudioRepository");

                const bySlug = await repository.getBySlug("forge-works");
                assert.strictEqual(bySlug?.id, studioAId);
                assert.strictEqual(await repository.getBySlug("nope"), null);

                const byTier = await repository.getByPlanTier("enterprise");
                assert.deepStrictEqual(byTier.map(t => t.id), [studioAId]);

                const byTag = await repository.getByTag("animation");
                assert.deepStrictEqual(byTag.map(t => t.id), [studioAId]);

                // the numeric cast means this compares as a number, not as text
                const largest = await repository.getLargest(5);
                assert.strictEqual(largest[0].id, studioAId);
                assert.strictEqual(largest.length, 2);

                // a projection, so it lives on the implementation rather than the domain interface - the
                // domain has no question shaped like "group by tier"
                const counts = await scope.resolve<SnapshotStudioRepository>("SnapshotStudioRepository")
                    .getCountByPlanTier();
                assert.deepStrictEqual([...counts].orderBy(t => t.tier),
                    [{ tier: "enterprise", count: 1 }, { tier: "free", count: 1 }]);
            }
            finally
            {
                await scope.dispose();
            }
        });

        await test("the query set's predicate uses the index it declared", async () =>
        {
            const predicate = SnapshotStudioRepository.indexes.eq("plan.tier", "enterprise");

            const explained = await db.executeQuery<any>(
                `explain (costs off) select data from studio_snaps where ${predicate.sql};`,
                ...predicate.params);
            const plan = explained.rows.map(t => t["QUERY PLAN"] as string).join("\n");

            // a two-row table will be scanned regardless, so this asserts the shape of the statement rather
            // than the plan - the planner assertions with enough rows to matter live in the library's suite
            assert.ok(plan.isNotEmptyOrWhiteSpace());
            assert.ok(predicate.sql.contains("data->>'tier'") || predicate.sql.contains(`"plan","tier"`),
                predicate.sql);
        });
    });

    await describe("Creator, and the tenant boundary", async () =>
    {
        await test("creators are invited into the studio the context names", async () =>
        {
            domainContext.organizationId = studioAId;

            // one scope per invite: each is a write, and a scope carries one unit of work
            await inScope(s => s.resolve<CreatorFactory>("CreatorFactory")
                .invite("ada@example.com", "Ada Lovelace", "lead"));
            await inScope(s => s.resolve<CreatorFactory>("CreatorFactory")
                .invite("grace@example.com", "Grace Hopper", "admin"));
            await inScope(s => s.resolve<CreatorFactory>("CreatorFactory")
                .invite("alan@example.com", "Alan Turing", "member"));

            const all = await inScope(s => s.resolve<CreatorRepository>("CreatorRepository").getAll());

            assert.strictEqual(all.length, 3);
            assert.ok(all.every(t => t.organizationId === studioAId));
        });

        // `getAll` means everything and `getByIds` means a lookup, and they are separate methods
        // because as one - `getAll(...ids)` - they were the same *call* when the list was empty. That
        // forced the empty case to stand for either everything or nothing, and whichever was chosen
        // silently betrayed the callers expecting the other.
        await test("getAll takes the whole studio; getByIds over an empty list takes nothing", async () =>
        {
            domainContext.organizationId = studioAId;

            await inScope(async s =>
            {
                const repository = s.resolve<CreatorRepository>("CreatorRepository");

                // asking for zero ids is unremarkable now: the caller passed an array
                assert.strictEqual((await repository.getByIds([])).length, 0);
                assert.strictEqual((await repository.getByIds(["   "])).length, 0);
                assert.strictEqual((await repository.getByIds(["crt_nosuchcreator"])).length, 0);

                const all = await repository.getAll();
                assert.strictEqual(all.length, 3);
                // and still scoped - `getAll` is this studio's rows, never the whole table
                assert.ok(all.every(t => t.organizationId === studioAId));

                const some = await repository.getByIds(all.take(2).map(t => t.id));
                assert.strictEqual(some.length, 2);
            });

            // and the same on the event stream repository, where `getAll` replays every aggregate -
            // the read the whole class depends on, since it has no query surface of its own
            await inScope(async s =>
            {
                const eventStream = s.resolve<EventStreamCreatorRepository>("EventStreamCreatorRepository");

                assert.strictEqual((await eventStream.getByIds([])).length, 0);
                assert.strictEqual((await eventStream.getAll()).length, 3);
            });
        });

        // The regression that prompted the split. Both event stream repositories answer every domain
        // question by loading the studio's aggregates and filtering in memory, so when `getAll()`
        // briefly returned nothing, thirteen methods across the two of them silently returned nothing
        // too - `checkIfEmailExists` among them, a uniqueness check that could never find a
        // collision. Nothing caught it, because the container registers the *snapshot* repositories
        // under the "CreatorRepository" and "StudioRepository" keys, so these were never exercised.
        // They are resolved by their own keys here for exactly that reason.
        await test("the event stream repositories' in-memory reads work, resolved by their own key", async () =>
        {
            domainContext.organizationId = studioAId;

            await inScope(async s =>
            {
                const creators = s.resolve<EventStreamCreatorRepository>("EventStreamCreatorRepository");

                assert.strictEqual(await creators.checkIfEmailExists("ada@example.com"), true);
                assert.strictEqual(await creators.checkIfEmailExists("nobody@example.com"), false);

                const ada = await creators.getByEmail("ada@example.com");
                assert.strictEqual(ada?.displayName, "Ada Lovelace");
                assert.strictEqual(await creators.getByEmail("nobody@example.com"), null);

                assert.strictEqual(await creators.countActive(), 3);
                assert.strictEqual((await creators.getByRole("lead")).length, 1);
                assert.strictEqual((await creators.countByRole()).length, 3);
            });

            await inScope(async s =>
            {
                const studios = s.resolve<EventStreamStudioRepository>("EventStreamStudioRepository");

                // the studio slugs were minted in the block above this one
                const studio = await studios.get(studioAId);

                assert.strictEqual(await studios.checkIfSlugExists(studio.slug), true);
                assert.strictEqual(await studios.checkIfSlugExists("no-such-slug"), false);
                // the studio is allowed to keep its own slug, which is what excludeId is for
                assert.strictEqual(await studios.checkIfSlugExists(studio.slug, studio.id), false);

                assert.strictEqual((await studios.getBySlug(studio.slug))?.id, studioAId);
            });
        });

        await test("the same email is free in another studio", async () =>
        {
            domainContext.organizationId = studioBId;

            // ada exists in studio A; the unique index leads with organization_id, so this is not a collision
            await inScope(s => s.resolve<CreatorFactory>("CreatorFactory")
                .invite("ada@example.com", "Ada Elsewhere", "member"));
            await inScope(s => s.resolve<CreatorFactory>("CreatorFactory")
                .invite("edsger@example.com", "Edsger Dijkstra", "lead"));

            const all = await inScope(s => s.resolve<CreatorRepository>("CreatorRepository").getAll());

            assert.strictEqual(all.length, 2);
            assert.ok(all.every(t => t.organizationId === studioBId));
        });

        await test("but not within one studio", async () =>
        {
            domainContext.organizationId = studioBId;

            const scope = createScope();

            try
            {
                await assert.rejects(
                    () => scope.resolve<CreatorFactory>("CreatorFactory")
                        .invite("ADA@example.com", "Ada Again", "member"),
                    CreatorEmailUnavailableException);
            }
            finally
            {
                await scope.dispose();
            }
        });

        // nothing in the repository mentions organization_id; `query` prepends it
        await test("every read is scoped to the current studio", async () =>
        {
            domainContext.organizationId = studioAId;

            const scope = createScope();

            try
            {
                const repository = scope.resolve<CreatorRepository>("CreatorRepository");

                const ada = await repository.getByEmail("ada@example.com");
                assert.strictEqual(ada?.displayName, "Ada Lovelace");
                assert.strictEqual(ada.organizationId, studioAId);

                const leads = await repository.getByRole("lead");
                assert.deepStrictEqual(leads.map(t => t.displayName), ["Ada Lovelace"]);

                // the or-composition is the case parentheses protect: without them the organization filter
                // could be escaped by the second arm
                const active = await repository.getActiveInRoles(["lead", "admin"]);
                assert.deepStrictEqual(active.map(t => t.displayName), ["Grace Hopper", "Ada Lovelace"]);
                assert.ok(active.every(t => t.organizationId === studioAId));

                const counts = await repository.countByRole();
                assert.strictEqual(counts.reduce((acc, t) => acc + t.count, 0), 3);
            }
            finally
            {
                await scope.dispose();
            }
        });

        await test("an array containment read is scoped too", async () =>
        {
            domainContext.organizationId = studioAId;

            const scope = createScope();

            try
            {
                const repository = scope.resolve<CreatorRepository>("CreatorRepository");
                const ada = await repository.getByEmail("ada@example.com");

                ada!.addSkill("rigging");
                await repository.save(ada!);

                const riggers = await repository.getBySkill("rigging");
                assert.deepStrictEqual(riggers.map(t => t.email), ["ada@example.com"]);

                // studio B has no riggers, and asks the same question
                domainContext.organizationId = studioBId;
                const otherScope = createScope();

                try
                {
                    const otherRiggers = await otherScope.resolve<CreatorRepository>("CreatorRepository")
                        .getBySkill("rigging");

                    assert.strictEqual(otherRiggers.length, 0);
                }
                finally
                {
                    await otherScope.dispose();
                }
            }
            finally
            {
                await scope.dispose();
            }
        });

        // the existence primitive itself, rather than the factory rule built on top of it
        await test("exists is scoped to the studio, and honours the excluded id", async () =>
        {
            domainContext.organizationId = studioAId;

            await inScope(async s =>
            {
                const repository = s.resolve<CreatorRepository>("CreatorRepository");

                assert.strictEqual(await repository.checkIfEmailExists("ada@example.com"), true);
                assert.strictEqual(await repository.checkIfEmailExists("nobody@example.com"), false);

                // edsger is in studio B only, so from here he does not exist
                assert.strictEqual(await repository.checkIfEmailExists("edsger@example.com"), false);

                // and ada does not collide with herself, which is what makes this usable on an update
                const ada = await repository.getByEmail("ada@example.com");
                assert.strictEqual(await repository.checkIfEmailExists("ada@example.com", ada!.id), false);
            });
        });

        // count, and the flow the studio's seat limit is built on
        await test("count feeds the studio's cached creator count", async () =>
        {
            domainContext.organizationId = studioAId;

            const activeCount = await inScope(s =>
                s.resolve<CreatorRepository>("CreatorRepository").countActive());

            assert.strictEqual(activeCount, 3);

            await inScope(async s =>
            {
                const repository = s.resolve<StudioRepository>("StudioRepository");
                const studio = await repository.get(studioAId);

                studio.setCreatorCount(activeCount);
                await repository.save(studio);
            });

            await inScope(async s =>
            {
                const studio = await s.resolve<StudioRepository>("StudioRepository").get(studioAId);

                assert.strictEqual(studio.creatorCount, 3);

                // the enterprise plan set earlier has an unlimited seat limit
                assert.strictEqual(studio.hasSeatAvailable(), true);
            });

            // a creator of its own, so deactivating does not disturb the three the later blocks rely on
            await inScope(s => s.resolve<CreatorFactory>("CreatorFactory")
                .invite("temp@example.com", "Temp Hire", "member"));

            assert.strictEqual(
                await inScope(s => s.resolve<CreatorRepository>("CreatorRepository").countActive()), 4);

            await inScope(async s =>
            {
                const repository = s.resolve<CreatorRepository>("CreatorRepository");
                const temp = await repository.getByEmail("temp@example.com");

                temp!.deactivate();
                await repository.save(temp!);
            });

            // deactivated, so it is still a row but no longer an active one - which is the difference
            // between `count` over a predicate and counting the table
            assert.strictEqual(
                await inScope(s => s.resolve<CreatorRepository>("CreatorRepository").countActive()), 3);
            assert.strictEqual(
                (await inScope(s => s.resolve<CreatorRepository>("CreatorRepository").getAll())).length, 4);
        });

        await test("a bigint-cast timestamp orders as a number", async () =>
        {
            domainContext.organizationId = studioAId;

            const scope = createScope();

            try
            {
                const recent = await scope.resolve<CreatorRepository>("CreatorRepository")
                    .getRecentlyJoined(0, 2);

                assert.strictEqual(recent.length, 2);
                assert.ok(recent[0].joinedAt >= recent[1].joinedAt);
            }
            finally
            {
                await scope.dispose();
            }
        });

        // the deliberate exception, and the only read that leaves the boundary
        await test("queryAcrossOrganizations is the only way out", async () =>
        {
            domainContext.organizationId = studioAId;

            const scope = createScope();

            try
            {
                const repository = scope.resolve<SnapshotCreatorRepository>("SnapshotCreatorRepository");

                const scoped = await repository.getByEmail("ada@example.com");
                assert.strictEqual(scoped?.organizationId, studioAId);

                const everywhere = await repository.queryAcrossStudiosByEmail("ada@example.com");

                assert.strictEqual(everywhere.length, 2);
                assert.deepStrictEqual(
                    everywhere.map(t => t.organizationId).orderBy(t => t),
                    [studioAId, studioBId].orderBy(t => t));
            }
            finally
            {
                await scope.dispose();
            }
        });
    });

    await describe("The unit of work", async () =>
    {
        // The compiler is the assertion here: `tsc` reports an unused '@ts-expect-error' as an error,
        // so a line that stops being rejected fails the build. The closure is never invoked - what is
        // being checked is that the call does not typecheck, not what it would do.
        await test("which door commits is a compile-time choice, not an argument", () =>
        {
            const rejected = async (repository: CreatorRepository, creator: Creator,
                unitOfWork: UnitOfWork): Promise<void> =>
            {
                // `save` owns its transaction and takes nothing else. Passing a unit of work used to
                // compile and silently suppress the commit - and passing the repository's *own*
                // `unitOfWork`, a public getter, read as though it changed nothing at all
                // @ts-expect-error - save takes the value alone
                await repository.save(creator, unitOfWork);

                // and the non-committing door will not silently own the transaction either: the unit
                // of work is required, so a forgotten argument is an error rather than a mode switch
                // @ts-expect-error - saveWithin requires the unit of work
                await repository.saveWithin(creator);
            };

            assert.strictEqual(typeof rejected, "function");
        });

        await test("an explicit unit of work makes two saves one transaction, and a rollback undoes both", async () =>
        {
            domainContext.organizationId = studioAId;

            const scope = createScope();
            const unitOfWork: UnitOfWork = new KnexPgUnitOfWork(
                scope.resolve<KnexPgDbConnectionFactory>("DbConnectionFactory"));

            let creatorId: string;
            let eventStreamRepository: EventStreamCreatorRepository;

            try
            {
                const repository = scope.resolve<CreatorRepository>("CreatorRepository");
                eventStreamRepository = scope.resolve<EventStreamCreatorRepository>(
                    "EventStreamCreatorRepository");

                const ada = await repository.getByEmail("ada@example.com");
                ada!.updateProfile("Ada L");

                const grace = await repository.getByEmail("grace@example.com");
                grace!.updateProfile("Grace H");
                creatorId = grace!.id;

                // `saveWithin` rather than `save`: the transaction boundary is this caller's, and the
                // repository commits nothing. Which door is used is what decides that now - it is no
                // longer inferred from whether a second argument happens to be present
                await repository.saveWithin(ada!, unitOfWork);
                await repository.saveWithin(grace!, unitOfWork);

                await unitOfWork.rollback();
            }
            finally
            {
                await scope.dispose();
            }

            const verifyScope = createScope();

            try
            {
                const repository = verifyScope.resolve<CreatorRepository>("CreatorRepository");

                assert.strictEqual((await repository.getByEmail("ada@example.com"))?.displayName,
                    "Ada Lovelace");
                assert.strictEqual((await repository.get(creatorId)).displayName, "Grace Hopper");
            }
            finally
            {
                await verifyScope.dispose();
            }

            // and nothing was published: onSave is registered as a commit callback, not called inline
            assert.strictEqual(eventStreamRepository.savedEvents.length, 0);
        });

        await test("a committed unit of work lands both saves and fires onSave", async () =>
        {
            domainContext.organizationId = studioAId;

            const scope = createScope();
            const unitOfWork: UnitOfWork = new KnexPgUnitOfWork(
                scope.resolve<KnexPgDbConnectionFactory>("DbConnectionFactory"));

            let eventStreamRepository: EventStreamCreatorRepository;

            try
            {
                const repository = scope.resolve<CreatorRepository>("CreatorRepository");
                eventStreamRepository = scope.resolve<EventStreamCreatorRepository>(
                    "EventStreamCreatorRepository");

                const ada = await repository.getByEmail("ada@example.com");
                ada!.updateProfile("Ada L");
                await repository.saveWithin(ada!, unitOfWork);

                const alan = await repository.getByEmail("alan@example.com");
                alan!.changeRole("lead");
                await repository.saveWithin(alan!, unitOfWork);

                assert.strictEqual(eventStreamRepository.savedEvents.length, 0);

                await unitOfWork.commit();

                assert.strictEqual(eventStreamRepository.savedEvents.length, 2);
            }
            finally
            {
                await scope.dispose();
            }

            const verifyScope = createScope();

            try
            {
                const repository = verifyScope.resolve<CreatorRepository>("CreatorRepository");

                assert.strictEqual((await repository.getByEmail("ada@example.com"))?.displayName, "Ada L");
                assert.strictEqual((await repository.getByEmail("alan@example.com"))?.role, "lead");
            }
            finally
            {
                await verifyScope.dispose();
            }
        });
    });
});
