import { Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import { serialize } from "@nivinjoseph/n-util";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { ColumnType, Db, DbConnectionConfig, DbConnectionFactory, KnexPgDb, KnexPgDbConnectionFactory, ReadModel, ReadModelData, ReadModelDriftIssue, ReadModelSchema, ReadModelTableCreator } from "../src/index.js";


class SilentLogger implements Logger
{
    public logDebug(_debug: string): Promise<void> { return Promise.resolve(); }
    public logInfo(_info: string): Promise<void> { return Promise.resolve(); }
    public logWarning(_warning: string | Exception): Promise<void> { return Promise.resolve(); }
    public logError(_error: string | Exception): Promise<void> { return Promise.resolve(); }
}

// its own table name (beacon_read_model), because node --test runs files in parallel and every test
// here creates, alters and drops a real table
@serialize
class Beacon extends ReadModel<Beacon, "zone" | "power" | "litAt" | "flags" | "code" | "ticks">
{
    @serialize public get zone(): string { return ""; }
    @serialize public get power(): number { return 0; }
    @serialize public get litAt(): number { return 0; }
    @serialize public get flags(): ReadonlyArray<string> { return []; }
    @serialize public get code(): string { return ""; }
    @serialize public get ticks(): ReadonlyArray<number> { return []; }

    public constructor(data: ReadModelData<Beacon>)
    {
        super(data);
    }
}

// one of every declaration kind: an indexed text, an uncast double, an indexed timestamptz, a GIN
// array, a unique text, a plain array, and a composite
const schema = ReadModelSchema.for(Beacon, {
    zone: { type: ColumnType.text, index: true },
    power: { type: ColumnType.doublePrecision },
    litAt: { type: ColumnType.timestamptz, index: true },
    flags: { type: ColumnType.textArray, index: true },
    code: { type: ColumnType.text, unique: true },
    ticks: { type: ColumnType.integerArray }
}).withIndex(["zone", "litAt"]);

const T = "beacon_read_model";

const compact = (issues: ReadonlyArray<ReadModelDriftIssue>): Array<string> =>
    issues.map(t => `${t.kind}(${t.severity}):${t.indexName ?? t.columnName ?? t.tableName}`);


await describe("Read model drift verification", async () =>
{
    let dbConnectionFactory: DbConnectionFactory;
    let db: Db;
    let creator: ReadModelTableCreator;

    const drop = (): Promise<void> => db.executeCommand(`drop table if exists ${T};`);

    const fresh = async (): Promise<void> =>
    {
        await drop();
        await creator.createReadModelTable(schema);
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
        creator = new ReadModelTableCreator(db, new SilentLogger());

        await drop();
    });

    after(async () =>
    {
        await drop();
        await dbConnectionFactory.dispose();
    });


    await test("a freshly created table verifies clean - which pins the catalog spellings every comparison rests on", async () =>
    {
        await fresh();

        assert.deepStrictEqual(await creator.verifyReadModelTable(schema), []);

        // the spellings themselves, so a Postgres upgrade that changes one fails here with a name
        const columns = await db.executeQuery<{ columnName: string; dataType: string; isNotNull: boolean; }>(`
            select a.attname as "columnName", format_type(a.atttypid, a.atttypmod) as "dataType", a.attnotnull as "isNotNull"
            from pg_attribute a join pg_class c on c.oid = a.attrelid
            where c.relname = ? and a.attnum > 0 and not a.attisdropped order by a.attnum;`, T);

        assert.deepStrictEqual(columns.rows.map(t => `${t.columnName}:${t.dataType}:${t.isNotNull}`), [
            "id:character varying(40):true",
            "zone:text:false",
            "power:double precision:false",
            "lit_at:timestamp with time zone:false",
            "flags:text[]:false",
            "code:text:false",
            "ticks:integer[]:false"
        ]);
    });

    await test("creation is idempotent: a second run changes nothing and still verifies clean", async () =>
    {
        await fresh();
        await creator.createReadModelTable(schema);

        assert.deepStrictEqual(await creator.verifyReadModelTable(schema), []);
    });

    await test("a table whose migration never ran is a single fatal table-missing", async () =>
    {
        await drop();

        const issues = await creator.verifyReadModelTable(schema);

        assert.deepStrictEqual(compact(issues), [`table-missing(fatal):${T}`]);
        assert.strictEqual(issues[0].fix, undefined);
    });

    await test("a column added to the schema after the migration is a fatal column-missing, and re-running the create is the fix", async () =>
    {
        await fresh();
        await db.executeCommand(`alter table ${T} drop column ticks;`);

        const issues = await creator.verifyReadModelTable(schema);

        assert.deepStrictEqual(compact(issues), ["column-missing(fatal):ticks"]);
        assert.strictEqual(issues[0].fix, `alter table ${T} add column if not exists ticks integer[];`);

        await creator.createReadModelTable(schema);

        assert.deepStrictEqual(await creator.verifyReadModelTable(schema), []);
    });

    await test("a column of another type is fatal with no fix", async () =>
    {
        await fresh();
        await db.executeCommand(`alter table ${T} alter column power type integer;`);

        const issues = await creator.verifyReadModelTable(schema);

        assert.deepStrictEqual(compact(issues), ["column-type-mismatch(fatal):power"]);
        assert.strictEqual(issues[0].fix, undefined);
    });

    await test("a hand-added not null and an undeclared column are advisories", async () =>
    {
        await fresh();
        await db.executeCommand(`alter table ${T} alter column zone set not null; alter table ${T} add column legacy text;`);

        const issues = await creator.verifyReadModelTable(schema);

        assert.deepStrictEqual(compact(issues), ["column-not-null(advisory):zone", "orphan-column(advisory):legacy"]);
        assert.ok(issues.every(t => t.fix === undefined));
    });

    await test("index drift is reported per kind, with a fix that reconcile then runs", async () =>
    {
        await fresh();
        await db.executeCommand(`
            drop index idx_${T}_zone;
            drop index idx_${T}_lit_at; create unique index idx_${T}_lit_at on ${T}(lit_at);
            drop index idx_${T}_flags_gin; create index idx_${T}_flags_gin on ${T}(flags);
            drop index idx_${T}_code_uq; create unique index idx_${T}_code_uq on ${T}(zone);
            create index idx_${T}_zzz on ${T}(power);
        `);

        const issues = await creator.verifyReadModelTable(schema);

        assert.deepStrictEqual(compact(issues), [
            `index-missing(fatal):idx_${T}_zone`,
            `index-uniqueness-mismatch(fatal):idx_${T}_lit_at`,
            `index-method-mismatch(fatal):idx_${T}_flags_gin`,
            `index-columns-mismatch(fatal):idx_${T}_code_uq`,
            `orphan-index(advisory):idx_${T}_zzz`
        ]);

        const result = await creator.reconcileReadModelTable(schema);

        assert.deepStrictEqual(compact(result.fixed), compact(issues).slice(0, 4));
        assert.deepStrictEqual(compact(result.remaining), [`orphan-index(advisory):idx_${T}_zzz`]);

        // the fixes stuck: a second pass finds nothing to do
        const again = await creator.reconcileReadModelTable(schema);
        assert.deepStrictEqual(again.fixed, []);
        assert.deepStrictEqual(compact(again.remaining), [`orphan-index(advisory):idx_${T}_zzz`]);
    });

    await test("a partial index or an opclass hiding under a declared name is drift, and reconcile replaces it", async () =>
    {
        await fresh();
        await db.executeCommand(`
            drop index idx_${T}_zone; create index idx_${T}_zone on ${T}(zone) where zone <> '';
            drop index idx_${T}_code_uq; create unique index idx_${T}_code_uq on ${T}(code text_pattern_ops);
        `);

        const issues = await creator.verifyReadModelTable(schema);

        assert.deepStrictEqual(compact(issues), [`index-definition-mismatch(fatal):idx_${T}_zone`, `index-definition-mismatch(fatal):idx_${T}_code_uq`]);

        const result = await creator.reconcileReadModelTable(schema);

        assert.deepStrictEqual(compact(result.fixed), compact(issues));
        assert.deepStrictEqual(result.remaining, []);
        assert.deepStrictEqual(await creator.verifyReadModelTable(schema), []);
    });

    await test("reconcile adds a missing column before building the index that needs it, and refuses a missing table", async () =>
    {
        await fresh();
        await db.executeCommand(`alter table ${T} drop column zone;`);

        const result = await creator.reconcileReadModelTable(schema);

        assert.deepStrictEqual(compact(result.fixed), ["column-missing(fatal):zone", `index-missing(fatal):idx_${T}_zone`, `index-missing(fatal):idx_${T}_zone_lit_at`]);
        assert.deepStrictEqual(result.remaining, []);

        await drop();

        const refused = await creator.reconcileReadModelTable(schema);
        assert.deepStrictEqual(refused.fixed, []);
        assert.deepStrictEqual(compact(refused.remaining), [`table-missing(fatal):${T}`]);
    });
});
