import { ArgumentException, Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import { serialize } from "@nivinjoseph/n-util";
import assert from "node:assert";
import test, { describe } from "node:test";
import { ColumnType, Db, QueryResult, ReadModel, ReadModelData, ReadModelDriftIssue, ReadModelSchema, ReadModelTableCreator, TransactionProvider } from "../src/index.js";


/**
 * Its own class name - node --test runs files in parallel, and the drift suite owns a real
 * `beacon_read_model`; this file never touches Postgres, but the name keeps the two from colliding
 * if that ever changes.
 */
@serialize
class Signal extends ReadModel<Signal, "channel" | "strength" | "seenAt" | "tags" | "code" | "offsets">
{
    @serialize public get channel(): string { return ""; }
    @serialize public get strength(): number { return 0; }
    @serialize public get seenAt(): number { return 0; }
    @serialize public get tags(): ReadonlyArray<string> { return []; }
    @serialize public get code(): string { return ""; }
    @serialize public get offsets(): ReadonlyArray<number> { return []; }

    public constructor(data: ReadModelData<Signal>)
    {
        super(data);
    }
}

const schema = ReadModelSchema.for(Signal, {
    channel: { type: ColumnType.text, index: true },
    strength: { type: ColumnType.doublePrecision },
    seenAt: { type: ColumnType.timestamptz, index: true },
    tags: { type: ColumnType.textArray, index: true },
    code: { type: ColumnType.text, unique: true },
    offsets: { type: ColumnType.integerArray }
}).withIndex(["channel", "seenAt"]);

const T = "signal_read_model";

function normalize(sql: string): string
{
    return sql.replaceAll(/\s+/g, " ").trim();
}

class SilentLogger implements Logger
{
    public logDebug(_debug: string): Promise<void> { return Promise.resolve(); }
    public logInfo(_info: string): Promise<void> { return Promise.resolve(); }
    public logWarning(_warning: string | Exception): Promise<void> { return Promise.resolve(); }
    public logError(_error: string | Exception): Promise<void> { return Promise.resolve(); }
}

/**
 * Records every command instead of executing it, so the emitted DDL can be asserted exactly.
 */
class CapturingDb implements Db
{
    private readonly _commands = new Array<string>();

    public get commands(): ReadonlyArray<string> { return this._commands.map(t => normalize(t)); }

    public executeCommand(sql: string, ...params: Array<any>): Promise<void>
    {
        assert.strictEqual(params.length, 0, "DDL should not carry bindings");
        this._commands.push(sql);

        return Promise.resolve();
    }

    public executeCommandWithinUnitOfWork(_transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>
    {
        return this.executeCommand(sql, ...params);
    }

    public executeQuery<T>(_sql: string, ..._params: Array<any>): Promise<QueryResult<T>>
    {
        throw new Error("not used");
    }
}

interface CatalogColumn { columnName: string; dataType: string; isNotNull: boolean; }
interface CatalogIndex { indexName: string; isUnique: boolean; method: string; columnCount: number; columnTypes: Array<string>; columnDefs: Array<string>; indexDef: string; }

/**
 * Answers the two catalog reads verification makes from fabricated rows, and records the fixes
 * reconcile executes - so every drift kind is testable with no database.
 */
class FakeCatalogDb extends CapturingDb
{
    public columns = new Array<CatalogColumn>();
    public indexes = new Array<CatalogIndex>();

    public override executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>
    {
        assert.deepStrictEqual(params, [T]);

        if (sql.contains("from pg_index"))
            return Promise.resolve(new QueryResult<T>(<Array<T>>this.indexes));

        if (sql.contains("from pg_attribute"))
            return Promise.resolve(new QueryResult<T>(<Array<T>>this.columns));

        throw new Error(`unexpected query: ${sql}`);
    }
}

const btree = (name: string, columns: Array<string>, isUnique = false): CatalogIndex =>
    ({ indexName: name, isUnique, method: "btree", columnCount: columns.length, columnTypes: columns.map(() => "text"), columnDefs: columns, indexDef: `CREATE INDEX ${name} ON ${T} USING btree (${columns.join(", ")})` });
const gin = (name: string, column: string): CatalogIndex =>
    ({ indexName: name, isUnique: false, method: "gin", columnCount: 1, columnTypes: ["text[]"], columnDefs: [column], indexDef: `CREATE INDEX ${name} ON ${T} USING gin (${column})` });

/**
 * The catalog exactly as creation leaves it.
 */
function provisioned(): FakeCatalogDb
{
    const db = new FakeCatalogDb();

    db.columns = [
        { columnName: "id", dataType: "character varying(40)", isNotNull: true },
        { columnName: "channel", dataType: "text", isNotNull: false },
        { columnName: "strength", dataType: "double precision", isNotNull: false },
        { columnName: "seen_at", dataType: "timestamp with time zone", isNotNull: false },
        { columnName: "tags", dataType: "text[]", isNotNull: false },
        { columnName: "code", dataType: "text", isNotNull: false },
        { columnName: "offsets", dataType: "integer[]", isNotNull: false }
    ];
    db.indexes = [
        btree(`${T}_pkey`, ["id"], true),
        btree(`idx_${T}_channel`, ["channel"]),
        btree(`idx_${T}_seen_at`, ["seen_at"]),
        gin(`idx_${T}_tags_gin`, "tags"),
        btree(`idx_${T}_code_uq`, ["code"], true),
        btree(`idx_${T}_channel_seen_at`, ["channel", "seen_at"])
    ];

    return db;
}

const compact = (issues: ReadonlyArray<ReadModelDriftIssue>): Array<string> =>
    issues.map(t => `${t.kind}(${t.severity}):${t.indexName ?? t.columnName ?? t.tableName}`);


await describe("ReadModelTableCreator", async () =>
{
    await describe("Emitted DDL", async () =>
    {
        await test("the table, one add-column per column, and the indexes - every statement idempotent", async () =>
        {
            const db = new CapturingDb();
            const creator = new ReadModelTableCreator(db, new SilentLogger());

            const info = await creator.createReadModelTable(schema);

            assert.deepStrictEqual(db.commands, [
                `create table if not exists ${T} ( id varchar(40) primary key, channel text, strength double precision, seen_at timestamptz, tags text[], code text, offsets integer[] );`,
                `alter table ${T} add column if not exists channel text;`,
                `alter table ${T} add column if not exists strength double precision;`,
                `alter table ${T} add column if not exists seen_at timestamptz;`,
                `alter table ${T} add column if not exists tags text[];`,
                `alter table ${T} add column if not exists code text;`,
                `alter table ${T} add column if not exists offsets integer[];`,
                `create index if not exists idx_${T}_channel on ${T}(channel);`,
                `create index if not exists idx_${T}_seen_at on ${T}(seen_at);`,
                `create index if not exists idx_${T}_tags_gin on ${T} using gin(tags);`,
                `create unique index if not exists idx_${T}_code_uq on ${T}(code);`,
                `create index if not exists idx_${T}_channel_seen_at on ${T}(channel, seen_at);`
            ]);

            assert.strictEqual(info.tableName, T);
            assert.deepStrictEqual(info.columns.map(t => `${t.column} ${t.type}`), ["channel text", "strength double precision", "seen_at timestamptz", "tags text[]", "code text", "offsets integer[]"]);
            assert.deepStrictEqual(info.createdIndexes.map(t => t.name), [`idx_${T}_channel`, `idx_${T}_seen_at`, `idx_${T}_tags_gin`, `idx_${T}_code_uq`, `idx_${T}_channel_seen_at`]);
        });

        await test("no column is ever not null - the one rule that keeps a day-2 column identical to a day-1 one", async () =>
        {
            const db = new CapturingDb();

            await new ReadModelTableCreator(db, new SilentLogger()).createReadModelTable(schema);

            assert.ok(db.commands.every(t => !t.contains("not null")));
        });

        await test("the constructor and the create guard their arguments", async () =>
        {
            assert.throws(() => new ReadModelTableCreator(<any>null, new SilentLogger()));
            await assert.rejects(() => new ReadModelTableCreator(new CapturingDb(), new SilentLogger()).createReadModelTable(<any>{ table: T }), ArgumentException);
        });

        // Nothing runs: the `@ts-expect-error` lines are the assertions. A schema widened to
        // ReadModelSchema<any> is refused by every consumer, the creator included - the brand is
        // checked where a schema is handed over, since the annotation itself passes TypeScript's variance rule
        await test("a widened schema is refused by every creator method (compile-time)", async () =>
        {
            const rejected = async (): Promise<void> =>
            {
                const widened: ReadModelSchema<any> = schema;
                const creator = new ReadModelTableCreator(new CapturingDb(), new SilentLogger());

                // @ts-expect-error - the intact brand is required
                await creator.createReadModelTable(widened);
                // @ts-expect-error - and by verify
                await creator.verifyReadModelTable(widened);
                // @ts-expect-error - and by reconcile
                await creator.reconcileReadModelTable(widened);
            };

            assert.strictEqual(typeof rejected, "function");
        });
    });

    await describe("Verification against a fabricated catalog", async () =>
    {
        await test("a table exactly as created verifies clean", async () =>
        {
            assert.deepStrictEqual(await new ReadModelTableCreator(provisioned(), new SilentLogger()).verifyReadModelTable(schema), []);
        });

        await test("a table whose migration never ran is a single fatal table-missing with no fix", async () =>
        {
            const issues = await new ReadModelTableCreator(new FakeCatalogDb(), new SilentLogger()).verifyReadModelTable(schema);

            assert.deepStrictEqual(compact(issues), [`table-missing(fatal):${T}`]);
            assert.strictEqual(issues[0].fix, undefined);
        });

        await test("a column added to the schema after the migration is a fatal column-missing carrying its add-column fix", async () =>
        {
            const db = provisioned();
            db.columns = db.columns.filter(t => t.columnName !== "offsets");

            const issues = await new ReadModelTableCreator(db, new SilentLogger()).verifyReadModelTable(schema);

            assert.deepStrictEqual(compact(issues), ["column-missing(fatal):offsets"]);
            assert.strictEqual(issues[0].fix, `alter table ${T} add column if not exists offsets integer[];`);
        });

        await test("a column of another type is fatal and carries no fix - a type change needs a cast decision", async () =>
        {
            const db = provisioned();
            db.columns = db.columns.map(t => t.columnName === "strength" ? { ...t, dataType: "integer" } : t);

            const issues = await new ReadModelTableCreator(db, new SilentLogger()).verifyReadModelTable(schema);

            assert.deepStrictEqual(compact(issues), ["column-type-mismatch(fatal):strength"]);
            assert.strictEqual(issues[0].fix, undefined);
            assert.ok(issues[0].message.contains("integer") && issues[0].message.contains("double precision"));
        });

        await test("a hand-added not null is an advisory; an undeclared column is an advisory", async () =>
        {
            const db = provisioned();
            db.columns = db.columns.map(t => t.columnName === "channel" ? { ...t, isNotNull: true } : t);
            db.columns.push({ columnName: "legacy", dataType: "text", isNotNull: false });

            const issues = await new ReadModelTableCreator(db, new SilentLogger()).verifyReadModelTable(schema);

            assert.deepStrictEqual(compact(issues), ["column-not-null(advisory):channel", "orphan-column(advisory):legacy"]);
            assert.ok(issues.every(t => t.fix === undefined));
        });

        await test("every index drift kind is reported with the statement that would fix it", async () =>
        {
            const db = provisioned();
            db.indexes = [
                btree(`${T}_pkey`, ["id"], true),
                // channel: missing
                btree(`idx_${T}_seen_at`, ["seen_at"], true),                  // uniqueness drift
                btree(`idx_${T}_tags_gin`, ["tags"]),                          // method drift
                btree(`idx_${T}_code_uq`, ["channel"], true),                  // columns drift
                btree(`idx_${T}_channel_seen_at`, ["channel", "seen_at"]),
                btree(`idx_${T}_zzz`, ["strength"])                            // orphan
            ];

            const issues = await new ReadModelTableCreator(db, new SilentLogger()).verifyReadModelTable(schema);

            assert.deepStrictEqual(compact(issues), [
                `index-missing(fatal):idx_${T}_channel`,
                `index-uniqueness-mismatch(fatal):idx_${T}_seen_at`,
                `index-method-mismatch(fatal):idx_${T}_tags_gin`,
                `index-columns-mismatch(fatal):idx_${T}_code_uq`,
                `orphan-index(advisory):idx_${T}_zzz`
            ]);
            assert.strictEqual(issues[0].fix, `create index if not exists idx_${T}_channel on ${T}(channel);`);
            assert.strictEqual(issues[1].fix, `drop index if exists idx_${T}_seen_at; create index if not exists idx_${T}_seen_at on ${T}(seen_at);`);
            assert.strictEqual(issues[2].fix, `drop index if exists idx_${T}_tags_gin; create index if not exists idx_${T}_tags_gin on ${T} using gin(tags);`);
            assert.strictEqual(issues[4].fix, undefined);
        });
    });

    await describe("Index definitions beyond the column names", async () =>
    {
        // pg_get_indexdef(oid, n, true) prints only the column for a per-column call, so a partial
        // predicate, an opclass or an ordering under the declared name is visible only in the full definition
        await test("a partial index under the declared name is a fatal definition mismatch with the drop-and-recreate fix", async () =>
        {
            const db = provisioned();
            db.indexes = db.indexes.map(t => t.indexName === `idx_${T}_channel`
                ? { ...t, indexDef: `CREATE INDEX idx_${T}_channel ON public.${T} USING btree (channel) WHERE (channel <> ''::text)` }
                : t);

            const issues = await new ReadModelTableCreator(db, new SilentLogger()).verifyReadModelTable(schema);

            assert.deepStrictEqual(compact(issues), [`index-definition-mismatch(fatal):idx_${T}_channel`]);
            assert.strictEqual(issues[0].fix, `drop index if exists idx_${T}_channel; create index if not exists idx_${T}_channel on ${T}(channel);`);
            assert.ok(issues[0].message.contains("WHERE"));
        });

        await test("an opclass or an ordering on a column is a fatal definition mismatch", async () =>
        {
            const db = provisioned();
            db.indexes = db.indexes.map(t =>
                t.indexName === `idx_${T}_channel` ? { ...t, indexDef: `CREATE INDEX idx_${T}_channel ON public.${T} USING btree (channel text_pattern_ops)` }
                : t.indexName === `idx_${T}_seen_at` ? { ...t, indexDef: `CREATE INDEX idx_${T}_seen_at ON public.${T} USING btree (seen_at DESC)` }
                : t);

            const issues = await new ReadModelTableCreator(db, new SilentLogger()).verifyReadModelTable(schema);

            assert.deepStrictEqual(compact(issues), [`index-definition-mismatch(fatal):idx_${T}_channel`, `index-definition-mismatch(fatal):idx_${T}_seen_at`]);
        });
    });

    await describe("Reconciliation against a fabricated catalog", async () =>
    {
        await test("runs the column fixes, then the index fixes, leaves the advisories, and reports both", async () =>
        {
            const db = provisioned();
            db.columns = db.columns.filter(t => t.columnName !== "offsets");
            db.columns.push({ columnName: "legacy", dataType: "text", isNotNull: false });
            db.indexes = db.indexes.filter(t => t.indexName !== `idx_${T}_channel`);

            const result = await new ReadModelTableCreator(db, new SilentLogger()).reconcileReadModelTable(schema);

            assert.deepStrictEqual(compact(result.fixed), ["column-missing(fatal):offsets", `index-missing(fatal):idx_${T}_channel`]);
            assert.deepStrictEqual(db.commands, [
                `alter table ${T} add column if not exists offsets integer[];`,
                `create index if not exists idx_${T}_channel on ${T}(channel);`
            ]);
            // the fake catalog does not change, so the closing verify still sees the two fatals - and the advisory
            assert.deepStrictEqual(compact(result.remaining), ["column-missing(fatal):offsets", "orphan-column(advisory):legacy", `index-missing(fatal):idx_${T}_channel`]);
        });

        await test("a missing table gates everything: nothing runs, and the issue is returned as remaining", async () =>
        {
            const db = new FakeCatalogDb();

            const result = await new ReadModelTableCreator(db, new SilentLogger()).reconcileReadModelTable(schema);

            assert.deepStrictEqual(result.fixed, []);
            assert.deepStrictEqual(compact(result.remaining), [`table-missing(fatal):${T}`]);
            assert.deepStrictEqual(db.commands, []);
        });
    });
});
