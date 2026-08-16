import { AggregateRoot, AggregateState, DomainEvent, OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { Db, DbConnectionConfig, DbConnectionFactory, DbTableCreator, JsonValueType, KnexPgDb, KnexPgDbConnectionFactory, SnapshotDriftIssue, SnapshotIndex, SnapshotQuerySet } from "../src/index.js";


class SilentLogger implements Logger
{
    public logDebug(_debug: string): Promise<void> { return Promise.resolve(); }
    public logInfo(_info: string): Promise<void> { return Promise.resolve(); }
    public logWarning(_warning: string | Exception): Promise<void> { return Promise.resolve(); }
    public logError(_error: string | Exception): Promise<void> { return Promise.resolve(); }
}

interface Origin
{
    city: string;
    port: string;
}

interface ParcelState extends AggregateState
{
    status: string;
    weight: number;
    slug: string;
    ref: string;
    origin: Origin;
    labels: Array<string>;
}

interface CharterState extends OrgAggregateState
{
    code: string;
    seats: number;
    tags: Array<string>;
}

// their own table names (parcel_snaps / charter_snaps), because node --test runs files in parallel
// and every test here creates and drops real tables
class Parcel extends AggregateRoot<ParcelState, DomainEvent<ParcelState>> { }
class Charter extends OrgAggregateRoot<CharterState, OrgDomainEvent<CharterState>> { }

const parcelType = Parcel as any;
const charterType = Charter as any;

// the full declaration a clean round trip is verified against: an uncast text path, a cast numeric
// path, a unique path, a nested path (multi-segment token), a composite with an explicit text cast
// (which Postgres elides - the one equivalence verification must not flag), and a GIN array path
const parcelIndexes = SnapshotQuerySet.for<ParcelState>()
    .withPath("status")
    .withPath("weight", { type: JsonValueType.numeric })
    .withPath("slug", { unique: true })
    .withPath("origin.city")
    .withComposite(["origin.port", { path: "ref", type: JsonValueType.text }])
    .withArrayPath("labels");

const compact = (issues: ReadonlyArray<SnapshotDriftIssue>): Array<string> =>
    issues.map(t => `${t.kind}(${t.severity}):${t.indexName ?? t.tableName}`);


await describe("Snapshot drift verification", async () =>
{
    let dbConnectionFactory: DbConnectionFactory;
    let db: Db;
    let creator: DbTableCreator;

    const dropAll = async (): Promise<void> =>
    {
        await db.executeCommand("drop table if exists parcel_snaps; drop table if exists parcel_events; drop table if exists charter_snaps; drop table if exists charter_events;");
    };

    before(async () =>
    {
        const config: DbConnectionConfig = {
            host: "localhost",
            port: "5432",
            database: "testdb",
            username: "postgres",
            password: "p@ssw0rd"
        };
        dbConnectionFactory = new KnexPgDbConnectionFactory(config);
        db = new KnexPgDb(dbConnectionFactory);
        creator = new DbTableCreator(db, new SilentLogger());

        await dropAll();
    });

    after(async () =>
    {
        await dropAll();
        await dbConnectionFactory.dispose();
    });


    await test("a freshly created table verifies clean, for every declaration kind at once", async () =>
    {
        await dropAll();

        await creator.createSnapshotTableForAggregate(parcelType, parcelIndexes);

        assert.deepStrictEqual(await creator.verifySnapshotTableForAggregate(parcelType, parcelIndexes), []);
    });

    await test("a table whose migration never ran is a single fatal table-missing", async () =>
    {
        await dropAll();

        const issues = await creator.verifySnapshotTableForAggregate(parcelType, parcelIndexes);

        assert.deepStrictEqual(compact(issues), ["table-missing(fatal):parcel_snaps"]);
        assert.ok(issues[0].message.contains("parcel_snaps"));
    });

    await test("event stream verification reports the missing table, and passes once created", async () =>
    {
        await dropAll();

        const missing = await creator.verifyEventStreamTableForAggregate(parcelType);
        assert.deepStrictEqual(compact(missing), ["table-missing(fatal):parcel_events"]);

        await creator.createEventStreamTableForAggregate(parcelType);
        assert.deepStrictEqual(await creator.verifyEventStreamTableForAggregate(parcelType), []);
    });

    // gap B: the most likely day-2 mistake - a path added to the query set, while the migration that
    // created the table is versioned and never re-runs
    await test("a path added after the migration ran is a fatal index-missing carrying the fix", async () =>
    {
        await dropAll();

        const migrated = SnapshotQuerySet.for<ParcelState>().withPath("status");
        await creator.createSnapshotTableForAggregate(parcelType, migrated);

        const current = SnapshotQuerySet.for<ParcelState>().withPath("status").withPath("slug");
        const issues = await creator.verifySnapshotTableForAggregate(parcelType, current);

        assert.deepStrictEqual(compact(issues), ["index-missing(fatal):idx_parcel_snaps_slug"]);
        // the message hands over the exact DDL, so the fix is copy-ready
        assert.ok(issues[0].message.contains("create index if not exists idx_parcel_snaps_slug on parcel_snaps((data->>'slug'));"));
    });

    // gap C: the drift the derived name cannot see - the name omits the cast, so `if not exists`
    // keeps the old uncast index while every query now casts
    await test("a cast added to an already-indexed path is a fatal index-cast-mismatch", async () =>
    {
        await dropAll();

        const migrated = SnapshotQuerySet.for<ParcelState>().withPath("weight");
        await creator.createSnapshotTableForAggregate(parcelType, migrated);

        const current = SnapshotQuerySet.for<ParcelState>().withPath("weight", { type: JsonValueType.numeric });
        const issues = await creator.verifySnapshotTableForAggregate(parcelType, current);

        assert.deepStrictEqual(compact(issues), ["index-cast-mismatch(fatal):idx_parcel_snaps_weight"]);
        assert.ok(issues[0].message.contains("as text where the declaration casts to numeric"));

        // and the reverse: a cast removed leaves a numeric index behind a text expression
        await dropAll();
        await creator.createSnapshotTableForAggregate(parcelType, current);

        const reverse = await creator.verifySnapshotTableForAggregate(parcelType, migrated);
        assert.deepStrictEqual(compact(reverse), ["index-cast-mismatch(fatal):idx_parcel_snaps_weight"]);
    });

    await test("JsonValueType.text and no cast are the same index - neither direction is drift", async () =>
    {
        await dropAll();

        const cast = SnapshotQuerySet.for<ParcelState>().withPath("status", { type: JsonValueType.text });
        const uncast = SnapshotQuerySet.for<ParcelState>().withPath("status");

        await creator.createSnapshotTableForAggregate(parcelType, cast);
        assert.deepStrictEqual(await creator.verifySnapshotTableForAggregate(parcelType, uncast), []);

        await dropAll();
        await creator.createSnapshotTableForAggregate(parcelType, uncast);
        assert.deepStrictEqual(await creator.verifySnapshotTableForAggregate(parcelType, cast), []);
    });

    // gap D: with derived names the uniqueness flag is encoded as `_uq`, so clearing it shows up as
    // a missing index plus an orphan whose message says the constraint is still being enforced
    await test("a cleared 'unique' is a missing index plus a unique orphan that names the consequence", async () =>
    {
        await dropAll();

        const migrated = SnapshotQuerySet.for<ParcelState>().withPath("slug", { unique: true });
        await creator.createSnapshotTableForAggregate(parcelType, migrated);

        const current = SnapshotQuerySet.for<ParcelState>().withPath("slug");
        const issues = await creator.verifySnapshotTableForAggregate(parcelType, current);

        assert.deepStrictEqual(compact(issues), [
            "index-missing(fatal):idx_parcel_snaps_slug",
            "orphan-index(advisory):idx_parcel_snaps_slug_uq"
        ]);
        assert.ok(issues[1].message.contains("unique"));
        assert.ok(issues[1].message.contains("keeps enforcing"));
    });

    // gap E: a path migrated scalar -> array; the `_gin` name is missing and the old btree lingers
    await test("a path migrated from scalar to array is a missing GIN index plus a btree orphan", async () =>
    {
        await dropAll();

        // the old declaration went through the raw door, as a real legacy btree over the array would have
        await creator.createSnapshotTableForAggregate(parcelType, {
            indexes: [SnapshotIndex.forRawPath<ParcelState>("labels")],
            arrayIndexes: []
        });

        const current = SnapshotQuerySet.for<ParcelState>().withArrayPath("labels");
        const issues = await creator.verifySnapshotTableForAggregate(parcelType, current);

        assert.deepStrictEqual(compact(issues), [
            "index-missing(fatal):idx_parcel_snaps_labels_gin",
            "orphan-index(advisory):idx_parcel_snaps_labels"
        ]);
    });

    // reachable only when a pinned `name` keeps the derived name stable across a changed declaration,
    // or when an index was built by hand under the conventional name
    await test("an index existing under the declared name but with the wrong shape is dissected", async () =>
    {
        await dropAll();

        await creator.createSnapshotTableForAggregate(parcelType);

        // hand-built impostors under the names the declarations derive
        await db.executeCommand("create unique index idx_parcel_snaps_status on parcel_snaps((data->>'status'));");
        await db.executeCommand("create index idx_parcel_snaps_labels_gin on parcel_snaps((data->'labels'));");

        const current = SnapshotQuerySet.for<ParcelState>()
            .withPath("status")
            .withArrayPath("labels");
        const issues = await creator.verifySnapshotTableForAggregate(parcelType, current);

        assert.deepStrictEqual(compact(issues), [
            "index-uniqueness-mismatch(fatal):idx_parcel_snaps_status",
            "index-method-mismatch(fatal):idx_parcel_snaps_labels_gin"
        ]);
    });

    await test("a GIN index over the wrong opclass is an advisory, not a fatal", async () =>
    {
        await dropAll();

        await creator.createSnapshotTableForAggregate(parcelType);
        await db.executeCommand("create index idx_parcel_snaps_labels_gin on parcel_snaps using gin((data->'labels') jsonb_ops);");

        const current = SnapshotQuerySet.for<ParcelState>().withArrayPath("labels");
        const issues = await creator.verifySnapshotTableForAggregate(parcelType, current);

        assert.deepStrictEqual(compact(issues), ["index-opclass-mismatch(advisory):idx_parcel_snaps_labels_gin"]);
    });

    await test("a hand-built index under the naming convention is an advisory orphan, never a fatal", async () =>
    {
        await dropAll();

        const indexes = SnapshotQuerySet.for<ParcelState>().withPath("slug");
        await creator.createSnapshotTableForAggregate(parcelType, indexes);

        // the hand-built index the docs themselves recommend for prefix LIKE
        await db.executeCommand("create index idx_parcel_snaps_slug_like on parcel_snaps((data->>'slug') text_pattern_ops);");

        const issues = await creator.verifySnapshotTableForAggregate(parcelType, indexes);

        assert.deepStrictEqual(compact(issues), ["orphan-index(advisory):idx_parcel_snaps_slug_like"]);
        assert.ok(issues.every(t => t.severity === "advisory"));
    });

    await test("an org table verifies clean, standalone organization_id index included", async () =>
    {
        await dropAll();

        // only an array declaration, so creation adds the standalone (organization_id) btree
        const arrayOnly = SnapshotQuerySet.for<CharterState>().withArrayPath("tags");
        await creator.createSnapshotTableForOrgAggregate(charterType, arrayOnly);
        assert.deepStrictEqual(await creator.verifySnapshotTableForOrgAggregate(charterType, arrayOnly), []);

        await dropAll();

        // btree declarations lead with organization_id and stand in for the standalone index
        const mixed = SnapshotQuerySet.for<CharterState>()
            .withPath("code")
            .withPath("seats", { type: JsonValueType.integer })
            .withArrayPath("tags");
        await creator.createSnapshotTableForOrgAggregate(charterType, mixed);
        assert.deepStrictEqual(await creator.verifySnapshotTableForOrgAggregate(charterType, mixed), []);
    });

    await test("an org declaration against a table created before the aggregate was org-scoped", async () =>
    {
        await dropAll();

        // the table a *plain* create would have made: no organization_id column
        await db.executeCommand("create table charter_snaps (id varchar(40) primary key, data jsonb not null);");

        const indexes = SnapshotQuerySet.for<CharterState>().withPath("code");
        const issues = await creator.verifySnapshotTableForOrgAggregate(charterType, indexes);

        assert.ok(compact(issues).contains("column-missing(fatal):charter_snaps"));
        assert.ok(compact(issues).contains("index-missing(fatal):idx_charter_snaps_code"));
    });

    await test("an org index that does not lead with organization_id is a fatal columns mismatch", async () =>
    {
        await dropAll();

        await db.executeCommand("create table charter_snaps (id varchar(40) primary key, organization_id varchar(40) not null, data jsonb not null);");
        // the index a plain create would have built: the expression alone, no leading column
        await db.executeCommand("create index idx_charter_snaps_code on charter_snaps((data->>'code'));");

        const indexes = SnapshotQuerySet.for<CharterState>().withPath("code");
        const issues = await creator.verifySnapshotTableForOrgAggregate(charterType, indexes);

        assert.deepStrictEqual(compact(issues), ["index-columns-mismatch(fatal):idx_charter_snaps_code"]);
    });

    await test("org event stream verification checks the organization_id column too", async () =>
    {
        await dropAll();

        await db.executeCommand("create table charter_events (id varchar(50) primary key, aggregate_id varchar(40) not null, aggregate_version integer not null, data jsonb not null);");

        const issues = await creator.verifyEventStreamTableForOrgAggregate(charterType);

        assert.deepStrictEqual(compact(issues), ["column-missing(fatal):charter_events"]);

        await dropAll();
        await creator.createEventStreamTableForOrgAggregate(charterType);
        assert.deepStrictEqual(await creator.verifyEventStreamTableForOrgAggregate(charterType), []);
    });

    // a declaration that is itself broken throws exactly as the create call would - only *drift*
    // comes back as issues
    await test("an invalid declaration throws instead of reporting drift", async () =>
    {
        await dropAll();
        await creator.createSnapshotTableForAggregate(parcelType);

        await assert.rejects(
            async () => creator.verifySnapshotTableForAggregate(parcelType, {
                indexes: [
                    SnapshotIndex.forRawPath<ParcelState>("status"),
                    SnapshotIndex.forRawPath<ParcelState>("status", JsonValueType.numeric)
                ],
                arrayIndexes: []
            }),
            (error: Error) => error.message.contains("the same path cannot be indexed with different types"));
    });
});
