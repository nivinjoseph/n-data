import { given } from "@nivinjoseph/n-defensive";
import { DomainContext } from "@nivinjoseph/n-domain";
import { ArgumentException, Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import { serialize } from "@nivinjoseph/n-util";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { AnyReadModel, ColumnType, Db, DbConnectionConfig, DbConnectionFactory, DbException, IntactReadModelSchema, KnexPgDb, KnexPgDbConnectionFactory, KnexPgUnitOfWork, QueryResult, ReadModel, ReadModelBaseRepository, ReadModelColumns, ReadModelData, ReadModelNotFoundException, ReadModelSchema, ReadModelTableCreator, TransactionProvider, UnitOfWork } from "../src/index.js";
import { ReadModelRowMapper } from "../src/read-model/read-model-row-mapper.js";


/**
 * One property per column kind, including the two the driver hands back as strings (bigint,
 * numeric), the timestamptz conversion, two array kinds, and a nullable text. Its own class name,
 * because node --test runs files in parallel and the Postgres block below owns a real table.
 */
@serialize
class LedgerEntry extends ReadModel<LedgerEntry, "account" | "amount" | "postedAt" | "memo" | "labels" | "isVoid" | "sequence" | "weights" | "counts">
{
    private readonly _account: string;
    private readonly _amount: number;
    private readonly _postedAt: number;
    private readonly _memo: string | null;
    private readonly _labels: ReadonlyArray<string>;
    private readonly _isVoid: boolean;
    private readonly _sequence: number;
    private readonly _weights: ReadonlyArray<number> | null;
    private readonly _counts: ReadonlyArray<number>;

    @serialize public get account(): string { return this._account; }
    @serialize public get amount(): number { return this._amount; }
    @serialize public get postedAt(): number { return this._postedAt; }
    @serialize public get memo(): string | null { return this._memo; }
    @serialize public get labels(): ReadonlyArray<string> { return this._labels; }
    @serialize public get isVoid(): boolean { return this._isVoid; }
    @serialize public get sequence(): number { return this._sequence; }
    @serialize public get weights(): ReadonlyArray<number> | null { return this._weights; }
    @serialize public get counts(): ReadonlyArray<number> { return this._counts; }

    // decorated but not in TDataKeys - the advisory the guard logs once
    @serialize public get kind(): string { return "ledger"; }

    public constructor(data: ReadModelData<LedgerEntry>)
    {
        super(data);

        // the one guard the fixture keeps: what a NULL in this column does on hydration is asserted below
        given(data.account, "account").ensureHasValue().ensureIsString();
        this._account = data.account;
        this._amount = data.amount;
        this._postedAt = data.postedAt;
        this._memo = data.memo;
        this._labels = data.labels;
        this._isVoid = data.isVoid;
        this._sequence = data.sequence;
        this._weights = data.weights;
        this._counts = data.counts;
    }
}

@serialize
class Other extends ReadModel<Other, "name">
{
    private readonly _name: string;

    @serialize public get name(): string { return this._name; }

    public constructor(data: ReadModelData<Other>)
    {
        super(data);
        this._name = data.name;
    }
}

const otherSchema = ReadModelSchema.for(Other, { name: { type: ColumnType.text } });

/**
 * A model that can only arrive through deserialization: n-domain refuses a fresh construction with an
 * undecorated key, but a hydration is a deserialization and has to admit it the same way.
 */
@serialize
class HalfDecorated extends ReadModel<HalfDecorated, "label" | "note">
{
    private readonly _label: string;
    private readonly _note: string;
    @serialize public get label(): string { return this._label; }
    public get note(): string { return this._note; }
    public constructor(data: ReadModelData<HalfDecorated>)
    {
        super(data);
        this._label = data.label;
        this._note = data.note;
    }
}

class HalfDecoratedRepository extends ReadModelBaseRepository<HalfDecorated>
{
    public static readonly schema = ReadModelSchema.for(HalfDecorated, { label: { type: ColumnType.text }, note: { type: ColumnType.text } });
    public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
    {
        super(domainContext, db, unitOfWork, logger, HalfDecoratedRepository.schema);
    }
}

/**
 * Counts `serialize()` calls, so the save path can be shown not to serialize for its once-logged advisories.
 */
@serialize
class Counting extends ReadModel<Counting, "name">
{
    public static serializations = 0;
    private readonly _name: string;
    @serialize public get name(): string { return this._name; }
    public constructor(data: ReadModelData<Counting>)
    {
        super(data);
        this._name = data.name;
    }
    public override serialize(): ReturnType<ReadModel<Counting, "name">["serialize"]>
    {
        Counting.serializations++;
        return super.serialize();
    }
}

class CountingRepository extends ReadModelBaseRepository<Counting>
{
    public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, schema: typeof countingSchema)
    {
        super(domainContext, db, unitOfWork, logger, schema);
    }
}

const countingSchema = ReadModelSchema.for(Counting, { name: { type: ColumnType.text } });

/**
 * Returned fresh so a test can build a schema object of its own - the shape guard tracks advisories
 * per schema object, and a process-wide static would make "logged once" unobservable.
 */
const ledgerColumns = (): ReadModelColumns<LedgerEntry> => ({
    account: { type: ColumnType.text, index: true },
    amount: { type: ColumnType.numeric },
    postedAt: { type: ColumnType.timestamptz, index: true },
    memo: { type: ColumnType.text },
    labels: { type: ColumnType.textArray, index: true },
    isVoid: { type: ColumnType.boolean },
    sequence: { type: ColumnType.bigint, unique: true },
    weights: { type: ColumnType.doublePrecisionArray },
    counts: { type: ColumnType.bigintArray }
});

/**
 * The documented subclass pattern: the schema static, the constructor handing it to the base, and
 * the protected doors each exposed under a domain-phrased name.
 */
class LedgerEntryRepository extends ReadModelBaseRepository<LedgerEntry>
{
    public static readonly schema = ReadModelSchema.for(LedgerEntry, ledgerColumns()).withIndex(["account", "postedAt"]);

    public get columns(): string { return this.selectList; }

    public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
    {
        super(domainContext, db, unitOfWork, logger, LedgerEntryRepository.schema);
    }

    public getByAccount(account: string): Promise<Array<LedgerEntry>>
    {
        return this.query(this.schema.eq("account", account));
    }

    public getRecent(account: string, limit: number, offset: number): Promise<Array<LedgerEntry>>
    {
        return this.query({
            where: this.schema.and(this.schema.eq("account", account), this.schema.eq("isVoid", false)),
            orderBy: this.schema.orderBy("postedAt", "desc"),
            limit, offset
        });
    }

    public getLabelled(label: string): Promise<Array<LedgerEntry>>
    {
        return this.query(this.schema.contains("labels", label));
    }

    public getActive(id: string): Promise<LedgerEntry | null>
    {
        return this.queryById(id, this.schema.eq("isVoid", false));
    }

    public getActiveByIds(ids: ReadonlyArray<string>): Promise<Array<LedgerEntry>>
    {
        return this.queryByIds(ids, this.schema.eq("isVoid", false));
    }

    public hasSequence(sequence: number, excludeId?: string): Promise<boolean>
    {
        return this.exists(this.schema.eq("sequence", sequence), excludeId);
    }

    public countFor(account: string): Promise<number>
    {
        return this.count(this.schema.eq("account", account));
    }

    public countAll(): Promise<number>
    {
        return this.count();
    }

    public async totalByAccount(): Promise<ReadonlyArray<{ account: string; total: number; }>>
    {
        const result = await this.queryRaw<{ account: string; total: number; }>(
            `select ${this.schema.columnFor("account")} as account, cast(sum(${this.schema.columnFor("amount")}) as double precision) as total
             from ${this.table} group by 1 order by 1;`);

        return result.rows;
    }

    public statement(sql: string, ...params: ReadonlyArray<any>): Promise<Array<LedgerEntry>>
    {
        return this.queryStatement(sql, ...params);
    }

    public foreign(): Promise<Array<LedgerEntry>>
    {
        // a predicate built by another schema - refused before any SQL runs
        return this.query(<any>otherSchema.eq("name", "x"));
    }
}

interface Recorded
{
    readonly sql: string;
    readonly params: ReadonlyArray<any>;
}

function normalize(sql: string): string
{
    return sql.replaceAll(/\s+/g, " ").trim();
}

/**
 * Records every statement with its bindings, and answers queries with whatever rows were queued.
 */
class CapturingDb implements Db
{
    private readonly _commands = new Array<Recorded>();
    private readonly _queries = new Array<Recorded>();
    private _rows = new Array<unknown>();
    private _failNextCommand = false;
    private _failCommandNumber = 0;

    public get commands(): ReadonlyArray<Recorded> { return this._commands.map(t => ({ sql: normalize(t.sql), params: t.params })); }
    public get queries(): ReadonlyArray<Recorded> { return this._queries.map(t => ({ sql: normalize(t.sql), params: t.params })); }

    public answerWith(rows: Array<unknown>): void { this._rows = rows; }
    public failNextCommand(): void { this._failNextCommand = true; }
    public failCommand(ordinal: number): void { this._failCommandNumber = ordinal; }

    public executeCommand(sql: string, ...params: Array<any>): Promise<void>
    {
        this._commands.push({ sql, params });

        if (this._failNextCommand || this._commands.length === this._failCommandNumber)
        {
            this._failNextCommand = false;
            return Promise.reject(new Error("boom"));
        }

        return Promise.resolve();
    }

    public executeCommandWithinUnitOfWork(_transactionProvider: TransactionProvider, sql: string, ...params: Array<any>): Promise<void>
    {
        return this.executeCommand(sql, ...params);
    }

    public executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>
    {
        this._queries.push({ sql, params });

        return Promise.resolve(new QueryResult<T>(<Array<T>>this._rows));
    }
}

class FakeUnitOfWork implements UnitOfWork
{
    public commits = 0;
    public rollbacks = 0;

    public getTransactionScope(): Promise<object> { return Promise.resolve({}); }
    public onCommit(_callback: () => Promise<void>, _priority?: number): void { /* unused */ }
    public commit(): Promise<void> { this.commits++; return Promise.resolve(); }
    public onRollback(_callback: () => Promise<void>, _priority?: number): void { /* unused */ }
    public rollback(): Promise<void> { this.rollbacks++; return Promise.resolve(); }
}

class RecordingLogger implements Logger
{
    public readonly warnings = new Array<string>();
    public readonly errors = new Array<string>();

    public logDebug(_debug: string): Promise<void> { return Promise.resolve(); }
    public logInfo(_info: string): Promise<void> { return Promise.resolve(); }
    public logWarning(warning: string | Exception): Promise<void> { this.warnings.push(String(warning)); return Promise.resolve(); }
    public logError(error: string | Exception): Promise<void> { this.errors.push(String(error)); return Promise.resolve(); }
}

const context: DomainContext = { userId: "tester" };

function harness(): { repo: LedgerEntryRepository; db: CapturingDb; uow: FakeUnitOfWork; logger: RecordingLogger; }
{
    const db = new CapturingDb();
    const uow = new FakeUnitOfWork();
    const logger = new RecordingLogger();

    return { repo: new LedgerEntryRepository(context, db, uow, logger), db, uow, logger };
}

const entry = (overrides?: Partial<ReadModelData<LedgerEntry>>): LedgerEntry => new LedgerEntry({
    id: "led_1", account: "acc_1", amount: 12.5, postedAt: 1700000000000, memo: null, labels: ["rent", "q4"],
    isVoid: false, sequence: 7, weights: null, counts: [3, 4], ...overrides
});

const SELECT = "select id, account, amount, posted_at, memo, labels, is_void, sequence, weights, counts from ledger_entry_read_model";

// a row as pg hands it back with no custom type parsers installed: bigint and numeric as strings,
// timestamptz as a Date, bigint[] as strings
const row = (overrides?: Record<string, unknown>): Record<string, unknown> => ({
    id: "led_1", account: "acc_1", amount: "12.50", posted_at: new Date(1700000000000), memo: null, labels: ["rent", "q4"],
    is_void: false, sequence: "7", weights: null, counts: ["3", "4"], ...overrides
});


await describe("ReadModelBaseRepository", async () =>
{
    await describe("Writes", async () =>
    {
        await test("save upserts every column in declaration order, converts the timestamp on the parameter side, and commits its own unit of work", async () =>
        {
            const { repo, db, uow } = harness();

            await repo.save(entry());

            assert.deepStrictEqual(db.commands, [{
                sql: "insert into ledger_entry_read_model (id, account, amount, posted_at, memo, labels, is_void, sequence, weights, counts) "
                    + "values (?, ?, ?, to_timestamp(? / 1000.0), ?, ?, ?, ?, ?, ?) "
                    + "on conflict (id) do update set account = excluded.account, amount = excluded.amount, posted_at = excluded.posted_at, memo = excluded.memo, "
                    + "labels = excluded.labels, is_void = excluded.is_void, sequence = excluded.sequence, weights = excluded.weights, counts = excluded.counts;",
                params: ["led_1", "acc_1", 12.5, 1700000000000, null, ["rent", "q4"], false, 7, null, [3, 4]]
            }]);
            assert.strictEqual(uow.commits, 1);
            assert.strictEqual(uow.rollbacks, 0);
        });

        await test("saveWithin writes into the caller's unit of work and commits nothing", async () =>
        {
            const { repo, db, uow } = harness();
            const shared = new FakeUnitOfWork();

            await repo.saveWithin(entry(), shared);

            assert.strictEqual(db.commands.length, 1);
            assert.strictEqual(uow.commits, 0);
            assert.strictEqual(shared.commits, 0);
            assert.strictEqual(shared.rollbacks, 0);
        });

        await test("a failed write rolls back the owned unit of work, logs, and rethrows; a shared one is left to its owner", async () =>
        {
            const { repo, db, uow, logger } = harness();

            db.failNextCommand();
            await assert.rejects(() => repo.save(entry()), /boom/);
            assert.strictEqual(uow.rollbacks, 1);
            assert.strictEqual(uow.commits, 0);
            assert.strictEqual(logger.errors.length, 1);

            const shared = new FakeUnitOfWork();
            db.failNextCommand();
            await assert.rejects(() => repo.saveWithin(entry(), shared), /boom/);
            assert.strictEqual(shared.rollbacks, 0);
        });

        await test("delete removes by id and commits; deleteWithin does not commit", async () =>
        {
            const { repo, db, uow } = harness();
            const shared = new FakeUnitOfWork();

            await repo.delete("led_1");
            await repo.deleteWithin(" led_2 ", shared);

            assert.deepStrictEqual(db.commands, [
                { sql: "delete from ledger_entry_read_model where id = ?;", params: ["led_1"] },
                { sql: "delete from ledger_entry_read_model where id = ?;", params: ["led_2"] }
            ]);
            assert.strictEqual(uow.commits, 1);
            assert.strictEqual(shared.commits, 0);
        });

        await test("saveAll writes a batch as one multi-row upsert, rows sorted by id so concurrent batches lock in one order, and commits its own unit of work", async () =>
        {
            const { repo, db, uow } = harness();

            // handed over out of order on purpose: the statement carries them sorted by id
            await repo.saveAll([
                entry({ id: "led_3", sequence: 3, labels: [] }),
                entry({ id: "led_1", sequence: 1 }),
                entry({ id: "led_2", sequence: 2, memo: "second", postedAt: 1700000001000 })
            ]);

            const row = "(?, ?, ?, to_timestamp(? / 1000.0), ?, ?, ?, ?, ?, ?)";
            assert.deepStrictEqual(db.commands, [{
                sql: "insert into ledger_entry_read_model (id, account, amount, posted_at, memo, labels, is_void, sequence, weights, counts) "
                    + `values ${row}, ${row}, ${row} `
                    + "on conflict (id) do update set account = excluded.account, amount = excluded.amount, posted_at = excluded.posted_at, memo = excluded.memo, "
                    + "labels = excluded.labels, is_void = excluded.is_void, sequence = excluded.sequence, weights = excluded.weights, counts = excluded.counts;",
                params: [
                    "led_1", "acc_1", 12.5, 1700000000000, null, ["rent", "q4"], false, 1, null, [3, 4],
                    "led_2", "acc_1", 12.5, 1700000001000, "second", ["rent", "q4"], false, 2, null, [3, 4],
                    "led_3", "acc_1", 12.5, 1700000000000, null, [], false, 3, null, [3, 4]
                ]
            }]);
            assert.strictEqual(uow.commits, 1);
        });

        await test("saveAllWithin writes into the caller's unit of work and commits nothing; an empty batch touches nothing at all", async () =>
        {
            const { repo, db, uow } = harness();
            const shared = new FakeUnitOfWork();

            await repo.saveAllWithin([entry()], shared);
            assert.strictEqual(db.commands.length, 1);
            assert.strictEqual(shared.commits, 0);

            await repo.saveAll([]);
            await repo.saveAllWithin([], shared);
            assert.strictEqual(db.commands.length, 1);
            assert.strictEqual(uow.commits, 0);
            assert.strictEqual(shared.commits, 0);
        });

        await test("a batch is chunked at 500 rows per statement - Postgres binds at most 65535 parameters", async () =>
        {
            const { repo, db } = harness();

            await repo.saveAll(Array.from({ length: 501 }, (_, i) => entry({ id: `led_b${i}`, sequence: 1000 + i })));

            assert.strictEqual(db.commands.length, 2);
            assert.strictEqual(db.commands[0].params.length, 500 * 10);
            assert.strictEqual((db.commands[0].sql.match(/to_timestamp/g) ?? []).length, 500);
            assert.strictEqual(db.commands[1].params.length, 10);
            // sorted by id, so the one row in the last chunk is the lexicographically greatest id
            assert.strictEqual(db.commands[1].params[0], "led_b99");
            assert.strictEqual(db.commands[0].params[0], "led_b0");
        });

        await test("a failure in a later chunk of saveAllWithin leaves the earlier chunks queued in the caller's transaction and rethrows", async () =>
        {
            const { repo, db } = harness();
            const shared = new FakeUnitOfWork();

            db.failCommand(2);
            await assert.rejects(() => repo.saveAllWithin(Array.from({ length: 501 }, (_, i) => entry({ id: `led_c${i}`, sequence: 2000 + i })), shared), /boom/);

            // the first chunk went out; discarding it is the caller's rollback, not this repository's
            assert.strictEqual(db.commands.length, 2);
            assert.strictEqual(db.commands[0].params.length, 500 * 10);
            assert.strictEqual(shared.commits, 0);
            assert.strictEqual(shared.rollbacks, 0);
        });

        await test("a batch is rejected whole, before anything is queued: a duplicate id, a bad value in any row, a foreign instance", async () =>
        {
            const { repo, db } = harness();

            // Postgres refuses to upsert one row twice in a statement, so it is refused here by name
            await assert.rejects(() => repo.saveAll([entry({ id: "led_1" }), entry({ id: "led_1", sequence: 9 })]),
                (e: Error) => e instanceof ArgumentException && e.message.contains("led_1"));
            // a bad row is named by position and id, so a ten-thousand-row batch is not a bisection exercise
            await assert.rejects(() => repo.saveAll([entry(), entry(<any>{ id: "led_2", sequence: 2, amount: "12.5" })]),
                (e: Error) => e instanceof ArgumentException && e.message.contains("models[1]") && e.message.contains("led_2") && e.message.contains("amount"));
            await assert.rejects(() => repo.saveAll([entry(), <any>new Other({ id: "oth_1", name: "x" })]),
                (e: Error) => e instanceof ArgumentException && e.message.contains("models[1]"));

            assert.strictEqual(db.commands.length, 0);
        });

        await test("a failed chunk rolls back an owned unit of work and rethrows", async () =>
        {
            const { repo, db, uow, logger } = harness();

            db.failNextCommand();
            await assert.rejects(() => repo.saveAll([entry(), entry({ id: "led_2", sequence: 2 })]), /boom/);

            assert.strictEqual(uow.rollbacks, 1);
            assert.strictEqual(uow.commits, 0);
            assert.strictEqual(logger.errors.length, 1);
        });

        await test("a value the column cannot hold is refused before anything is queued", async () =>
        {
            const { repo, db } = harness();

            await assert.rejects(() => repo.save(entry(<any>{ amount: "12.5" })), ArgumentException);
            await assert.rejects(() => repo.save(entry(<any>{ labels: ["a", null] })), ArgumentException);
            await assert.rejects(() => repo.save(<any>new Other({ id: "oth_1", name: "x" })), ArgumentException);

            assert.strictEqual(db.commands.length, 0);
        });

        await test("the advisories are logged once per schema, not once per save", async () =>
        {
            // a schema object of this test's own, so its first save is provably the first the guard sees
            const fresh = ReadModelSchema.for(LedgerEntry, ledgerColumns());

            class FreshRepository extends ReadModelBaseRepository<LedgerEntry>
            {
                public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
                {
                    super(domainContext, db, unitOfWork, logger, fresh);
                }
            }

            const logger = new RecordingLogger();
            const repo = new FreshRepository(context, new CapturingDb(), new FakeUnitOfWork(), logger);

            await repo.save(entry());
            const afterFirst = logger.warnings.length;
            await repo.save(entry({ id: "led_2", sequence: 8 }));

            // `kind` is decorated but not a column - a shape advisory - logged on the first save of
            // this schema and never again
            assert.strictEqual(afterFirst, 1);
            assert.ok(logger.warnings[0].contains("kind"));
            assert.strictEqual(logger.warnings.length, 1);
        });

        await test("the save path does not serialize the model: the advisories come from the class's metadata", async () =>
        {
            const logger = new RecordingLogger();
            const repo = new CountingRepository(context, new CapturingDb(), new FakeUnitOfWork(), logger, countingSchema);

            Counting.serializations = 0;
            await repo.save(new Counting({ id: "cnt_1", name: "a" }));
            await repo.save(new Counting({ id: "cnt_2", name: "b" }));

            assert.strictEqual(Counting.serializations, 0);
        });
    });

    await describe("Reads", async () =>
    {
        await test("rows hydrate through the class: strings from the driver become numbers, the timestamp becomes epoch ms", async () =>
        {
            const { repo, db } = harness();

            db.answerWith([row()]);
            const result = await repo.get("led_1");

            assert.ok(result instanceof LedgerEntry);
            assert.strictEqual(result.id, "led_1");
            assert.strictEqual(result.amount, 12.5);
            assert.strictEqual(result.postedAt, 1700000000000);
            assert.strictEqual(result.sequence, 7);
            assert.deepStrictEqual(result.counts, [3, 4]);
            assert.strictEqual(result.memo, null);
            assert.strictEqual(result.weights, null);
            assert.deepStrictEqual(result.labels, ["rent", "q4"]);
            assert.deepStrictEqual(db.queries, [{ sql: `${SELECT} where (id in (?));`, params: ["led_1"] }]);
        });

        await test("a hydration is a deserialization: a key whose getter is undecorated hydrates, as the deserializer would admit it", async () =>
        {
            const db = new CapturingDb();
            const repo = new HalfDecoratedRepository(context, db, new FakeUnitOfWork(), new RecordingLogger());

            // constructible only this way, through the $typename the deserializer passes
            await repo.save(new HalfDecorated(<any>{ $typename: "HalfDecorated", id: "hd_1", label: "a", note: "b" }));
            assert.deepStrictEqual(db.commands[0].params, ["hd_1", "a", "b"]);

            db.answerWith([{ id: "hd_1", label: "a", note: "b" }]);
            const loaded = await repo.get("hd_1");

            assert.strictEqual(loaded.note, "b");
            assert.strictEqual(loaded.label, "a");
        });

        await test("a bigint beyond the safe integer range cannot be hydrated silently", async () =>
        {
            const { repo, db } = harness();

            db.answerWith([row({ sequence: "9007199254740993" })]);
            await assert.rejects(() => repo.get("led_1"), /safe integer/);
        });

        await test("a row missing a declared column is refused by name; an extra column is ignored", async () =>
        {
            const { repo, db } = harness();

            const { memo: _memo, ...withoutMemo } = row();
            db.answerWith([withoutMemo]);
            await assert.rejects(() => repo.get("led_1"), /memo/);

            db.answerWith([row({ stray: 1 })]);
            assert.strictEqual((await repo.get("led_1")).account, "acc_1");
        });

        await test("get throws ReadModelNotFoundException on a miss; the filtered doors return null or empty", async () =>
        {
            const { repo, db } = harness();

            db.answerWith([]);
            await assert.rejects(() => repo.get("led_9"), (e: Error) => e instanceof ReadModelNotFoundException && e.message.contains("LedgerEntry") && e.message.contains("led_9"));
            assert.strictEqual(await repo.getActive("led_9"), null);
            assert.deepStrictEqual(await repo.getActiveByIds(["led_9"]), []);
        });

        await test("getByIds trims and drops blank ids, and runs nothing when none are left", async () =>
        {
            const { repo, db } = harness();

            assert.deepStrictEqual(await repo.getByIds([]), []);
            assert.deepStrictEqual(await repo.getByIds([" ", ""]), []);
            assert.strictEqual(db.queries.length, 0);

            db.answerWith([]);
            await repo.getByIds([" led_1 ", "led_2"]);
            assert.deepStrictEqual(db.queries, [{ sql: `${SELECT} where (id in (?,?));`, params: ["led_1", "led_2"] }]);
        });

        await test("the statements the doors build are pinned", async () =>
        {
            const { repo, db } = harness();
            db.answerWith([]);

            await repo.getAll();
            await repo.getByAccount("acc_1");
            await repo.getRecent("acc_1", 10, 20);
            await repo.getLabelled("rent");
            await repo.getActive("led_1");
            await repo.getActiveByIds(["led_1", "led_2"]);

            assert.deepStrictEqual(db.queries, [
                { sql: `${SELECT};`, params: [] },
                { sql: `${SELECT} where ((account = ?));`, params: ["acc_1"] },
                { sql: `${SELECT} where (((account = ?) and (is_void = ?))) order by posted_at desc limit ? offset ?;`, params: ["acc_1", false, 10, 20] },
                { sql: `${SELECT} where ((labels @> cast(? as text[])));`, params: [["rent"]] },
                { sql: `${SELECT} where (id in (?) and ((is_void = ?)));`, params: ["led_1", false] },
                { sql: `${SELECT} where (id in (?,?) and ((is_void = ?)));`, params: ["led_1", "led_2", false] }
            ]);
        });

        await test("exists and count build their own statements and read the answer, not the rows", async () =>
        {
            const { repo, db } = harness();

            db.answerWith([{ "?column?": 1 }]);
            assert.strictEqual(await repo.hasSequence(7, "led_1"), true);
            db.answerWith([]);
            assert.strictEqual(await repo.hasSequence(7), false);
            db.answerWith([{ count: 3 }]);
            assert.strictEqual(await repo.countFor("acc_1"), 3);
            db.answerWith([{ count: 0 }]);
            assert.strictEqual(await repo.countAll(), 0);

            assert.deepStrictEqual(db.queries.map(t => t.sql), [
                "select 1 from ledger_entry_read_model where ((sequence = ?)) and id <> ? limit 1;",
                "select 1 from ledger_entry_read_model where ((sequence = ?)) limit 1;",
                "select cast(count(*) as int) as count from ledger_entry_read_model where ((account = ?));",
                "select cast(count(*) as int) as count from ledger_entry_read_model;"
            ]);
            assert.deepStrictEqual(db.queries[0].params, [7, "led_1"]);
        });

        await test("queryRaw hands back the rows untouched; queryStatement hydrates whatever selects the columns", async () =>
        {
            const { repo, db } = harness();

            db.answerWith([{ account: "acc_1", total: 12.5 }]);
            assert.deepStrictEqual(await repo.totalByAccount(), [{ account: "acc_1", total: 12.5 }]);

            db.answerWith([row()]);
            const hydrated = await repo.statement(`select * from ${LedgerEntryRepository.schema.table} where account = ?;`, "acc_1");
            assert.strictEqual(hydrated[0].amount, 12.5);
            assert.deepStrictEqual(db.queries[1], { sql: "select * from ledger_entry_read_model where account = ?;", params: ["acc_1"] });
        });

        await test("a predicate built by another schema is refused before any SQL runs", async () =>
        {
            const { repo, db } = harness();

            await assert.rejects(() => repo.foreign(), (e: Error) => e instanceof ArgumentException && e.message.contains("other_read_model"));
            assert.strictEqual(db.queries.length, 0);
        });

        await test("the select list is the id and every declared column, for subclasses writing joins", async () =>
        {
            assert.strictEqual(harness().repo.columns, "id, account, amount, posted_at, memo, labels, is_void, sequence, weights, counts");
        });
    });

    await describe("The row mapper's chunking", async () =>
    {
        await test("the chunk size follows Postgres' parameter limit, not the 500-row cap, for a wide table", async () =>
        {
            const wide = new ReadModelRowMapper("wide_read_model", "Wide",
                Array.from({ length: 200 }, (_, i) => ({ key: `c${i}`, column: `c${i}`, type: ColumnType.text, index: false, unique: false })));

            // 201 parameters per row: floor(65535 / 201)
            assert.strictEqual(wide.chunkSize, 326);
            assert.strictEqual(new ReadModelRowMapper("t", "T", [{ key: "a", column: "a", type: ColumnType.text, index: false, unique: false }]).chunkSize, 500);
        });

        await test("a statement is rendered only for a row count the chunk admits", async () =>
        {
            const mapper = new ReadModelRowMapper("t", "T", [{ key: "a", column: "a", type: ColumnType.text, index: false, unique: false }]);

            assert.throws(() => mapper.upsertSqlFor(0), ArgumentException);
            assert.throws(() => mapper.upsertSqlFor(501), ArgumentException);
            assert.throws(() => mapper.upsertSqlFor(1.5), ArgumentException);
            assert.strictEqual(mapper.upsertSqlFor(1), mapper.upsertSql);
            assert.strictEqual(mapper.upsertSqlFor(500), mapper.upsertSqlFor(500));
        });
    });

    // Nothing is instantiated: the `@ts-expect-error` lines are the assertions, and tsc fails on an
    // unused one.
    await describe("The subclass pattern (compile-time)", async () =>
    {
        await test("the schema handed to the base must be intact and the repository's own model", async () =>
        {
            const rejected = (): void =>
            {
                const widened: ReadModelSchema<any> = LedgerEntryRepository.schema;

                class WidenedRepository extends ReadModelBaseRepository<LedgerEntry>
                {
                    public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
                    {
                        // @ts-expect-error - ReadModelSchema<any> discards column and value checking; the brand refuses it
                        super(domainContext, db, unitOfWork, logger, widened);
                    }
                }

                class WrongModelRepository extends ReadModelBaseRepository<LedgerEntry>
                {
                    public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
                    {
                        // @ts-expect-error - another model's schema
                        super(domainContext, db, unitOfWork, logger, otherSchema);
                    }
                }

                class Doors extends LedgerEntryRepository
                {
                    public async rejected(): Promise<void>
                    {
                        // @ts-expect-error - get takes the id alone; queryById is where a predicate goes
                        await this.get("led_1", this.schema.eq("isVoid", false));
                        // @ts-expect-error - getAll is the whole table; it takes no ids
                        await this.getAll("led_1");
                        // @ts-expect-error - saveAll takes the array itself, not a rest parameter
                        await this.saveAll(entry(), entry());
                        // @ts-expect-error - the narrow schema type reaches the subclass
                        await this.query(this.schema.eq("nope", 1));
                    }
                }

                assert.strictEqual(typeof WidenedRepository, "function");
                assert.strictEqual(typeof WrongModelRepository, "function");
                assert.strictEqual(typeof Doors, "function");
            };

            assert.strictEqual(typeof rejected, "function");
        });

        // An application-level generic layer between the base and the concrete repositories is a
        // realistic shape. It forwards the schema it is handed, and the brand decides which parameter
        // type it may take: the intact one is accepted; `ReadModelSchema<T>` is refused, because under
        // an unresolved T the phantom cannot be known to be `true`
        await test("a generic intermediate repository forwards the intact schema type (compile-time)", async () =>
        {
            const pinned = (): void =>
            {
                abstract class ForwardingRepository<T extends AnyReadModel> extends ReadModelBaseRepository<T>
                {
                    protected constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, schema: IntactReadModelSchema<T>)
                    {
                        super(domainContext, db, unitOfWork, logger, schema);
                    }
                }

                abstract class LooselyForwardingRepository<T extends AnyReadModel> extends ReadModelBaseRepository<T>
                {
                    protected constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, schema: ReadModelSchema<T>)
                    {
                        // @ts-expect-error - a generic layer must take IntactReadModelSchema<T>, which is what the message says
                        super(domainContext, db, unitOfWork, logger, schema);
                    }
                }

                class Concrete extends ForwardingRepository<LedgerEntry>
                {
                    public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
                    {
                        super(domainContext, db, unitOfWork, logger, LedgerEntryRepository.schema);
                    }
                }

                assert.strictEqual(typeof LooselyForwardingRepository, "function");
                assert.strictEqual(typeof Concrete, "function");
            };

            assert.strictEqual(typeof pinned, "function");
        });
    });
});


await describe("ReadModelBaseRepository against Postgres", async () =>
{
    let dbConnectionFactory: DbConnectionFactory;
    let db: Db;
    const logger = new RecordingLogger();

    const T = LedgerEntryRepository.schema.table;

    // a repository per operation, as a scoped container would resolve it: `save` commits the unit of
    // work it was built over, and a committed unit of work is dead
    const repository = (): LedgerEntryRepository => new LedgerEntryRepository(context, db, new KnexPgUnitOfWork(dbConnectionFactory), logger);

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

        await db.executeCommand(`drop table if exists ${T};`);
        await new ReadModelTableCreator(db, logger).createReadModelTable(LedgerEntryRepository.schema);
    });

    after(async () =>
    {
        await db.executeCommand(`drop table if exists ${T};`);
        await dbConnectionFactory.dispose();
    });


    await test("every column kind round-trips: numeric and bigint as numbers, the timestamp to the millisecond, arrays with awkward elements", async () =>
    {
        const saved = entry({
            id: "led_rt", amount: 1234.56, postedAt: -86400000 + 123, memo: "a \"quoted\" memo", sequence: 9007199254740991,
            labels: ["a\"b", "c\\d", "e,f", "{g}", "", "NULL"], weights: [1.5, -2.25], counts: [3, 4]
        });

        await repository().save(saved);
        const loaded = await repository().get("led_rt");

        assert.deepStrictEqual(loaded.serialize(), saved.serialize());
        assert.strictEqual(loaded.amount, 1234.56);
        assert.strictEqual(loaded.postedAt, -86400000 + 123);
        assert.strictEqual(loaded.sequence, 9007199254740991);
    });

    await test("an empty array and a null array are different values, and both come back", async () =>
    {
        await repository().save(entry({ id: "led_arr", sequence: 11, labels: [], weights: null, counts: [] }));
        const loaded = await repository().get("led_arr");

        assert.deepStrictEqual(loaded.labels, []);
        assert.strictEqual(loaded.weights, null);
        assert.deepStrictEqual(loaded.counts, []);
    });

    await test("a second save of the same id replaces the row rather than adding one", async () =>
    {
        await repository().save(entry({ id: "led_up", sequence: 21, amount: 1, memo: null }));
        await repository().save(entry({ id: "led_up", sequence: 21, amount: 2, memo: "revised" }));

        const loaded = await repository().get("led_up");

        assert.strictEqual(loaded.amount, 2);
        assert.strictEqual(loaded.memo, "revised");
        assert.strictEqual((await repository().statement(`select * from ${T} where id = ?;`, "led_up")).length, 1);
    });

    await test("the unique index enforces the natural key", async () =>
    {
        await repository().save(entry({ id: "led_u1", sequence: 31 }));

        await assert.rejects(() => repository().save(entry({ id: "led_u2", sequence: 31 })), DbException);
        assert.strictEqual(await repository().hasSequence(31), true);
        assert.strictEqual(await repository().hasSequence(31, "led_u1"), false);
    });

    await test("the predicates return the right rows, and the raw door returns numbers", async () =>
    {
        await db.executeCommand(`delete from ${T};`);

        await repository().save(entry({ id: "led_p1", account: "acc_p", amount: 10, postedAt: 1000, labels: ["rent"], sequence: 41 }));
        await repository().save(entry({ id: "led_p2", account: "acc_p", amount: 20, postedAt: 2000, labels: ["rent", "late"], sequence: 42 }));
        await repository().save(entry({ id: "led_p3", account: "acc_p", amount: 30, postedAt: 3000, labels: [], sequence: 43, isVoid: true }));
        await repository().save(entry({ id: "led_p4", account: "acc_q", amount: 5, postedAt: 4000, labels: ["late"], sequence: 44 }));

        assert.deepStrictEqual((await repository().getByAccount("acc_p")).map(t => t.id).sort(), ["led_p1", "led_p2", "led_p3"]);
        assert.deepStrictEqual((await repository().getLabelled("late")).map(t => t.id).sort(), ["led_p2", "led_p4"]);
        assert.deepStrictEqual((await repository().getRecent("acc_p", 1, 0)).map(t => t.id), ["led_p2"]);
        assert.deepStrictEqual((await repository().getRecent("acc_p", 1, 1)).map(t => t.id), ["led_p1"]);
        assert.strictEqual(await repository().getActive("led_p3"), null);
        assert.strictEqual((await repository().getActive("led_p1"))?.id, "led_p1");
        assert.deepStrictEqual((await repository().getActiveByIds(["led_p1", "led_p3", "led_p4"])).map(t => t.id).sort(), ["led_p1", "led_p4"]);
        assert.strictEqual(await repository().countFor("acc_p"), 3);
        assert.strictEqual(await repository().countAll(), 4);
        assert.deepStrictEqual(await repository().totalByAccount(), [{ account: "acc_p", total: 60 }, { account: "acc_q", total: 5 }]);
    });

    await test("the declared indexes serve the predicates, including the timestamp comparison and containment", async () =>
    {
        await db.executeCommand(`
            insert into ${T} (id, account, amount, posted_at, memo, labels, is_void, sequence, weights, counts)
            select 'led_s' || i, 'acc_s' || (i % 50), i, now() - (i || ' seconds')::interval, null, array['l' || i, 'shared'], false, 100000 + i, null, array[i]
            from generate_series(1, 3000) as i;
            analyze ${T};
        `);

        const schema = LedgerEntryRepository.schema;
        const plan = async (sql: string, ...params: Array<any>): Promise<string> =>
            (await db.executeQuery<Record<string, string>>(`explain (costs off) ${sql}`, ...params)).rows.map(t => Object.values(t)[0]).join("\n");

        const byAccount = schema.eq("account", "acc_s7");
        const accountPlan = await plan(`select id from ${T} where ${byAccount.sql};`, ...byAccount.params);
        assert.ok(accountPlan.contains(`idx_${T}_account`), accountPlan);
        assert.ok(!accountPlan.contains("Seq Scan"), accountPlan);

        const since = schema.gte("postedAt", Date.now() - 100000);
        const sincePlan = await plan(`select id from ${T} where ${since.sql};`, ...since.params);
        assert.ok(sincePlan.contains(`idx_${T}_posted_at`), sincePlan);

        const labelled = schema.contains("labels", "l3");
        const labelledPlan = await plan(`select id from ${T} where ${labelled.sql};`, ...labelled.params);
        assert.ok(labelledPlan.contains(`idx_${T}_labels_gin`), labelledPlan);
    });

    await test("a value the class cannot hold surfaces at hydration, by name", async () =>
    {
        await db.executeCommand(`insert into ${T} (id, account, amount, posted_at, memo, labels, is_void, sequence, weights, counts)
            values ('led_big', 'acc_big', 1, now(), null, '{}', false, 9007199254740993, null, '{}');`);
        await assert.rejects(() => repository().get("led_big"), /safe integer/);

        await db.executeCommand(`insert into ${T} (id, amount) values ('led_null', 1);`);
        await assert.rejects(() => repository().get("led_null"), /account/);
    });

    await test("queryStatement hydrates a select *, and refuses a statement that leaves a column out", async () =>
    {
        const hydrated = await repository().statement(`select * from ${T} where id = ?;`, "led_p1");
        assert.strictEqual(hydrated[0].amount, 10);

        await assert.rejects(() => repository().statement(`select id, account from ${T} where id = ?;`, "led_p1"), /amount/);
    });

    await test("delete removes the row, and deleting a missing id is a no-op", async () =>
    {
        await repository().delete("led_p1");
        await assert.rejects(() => repository().get("led_p1"), ReadModelNotFoundException);
        await repository().delete("led_p1");
    });

    await test("saveWithin lands on commit and not on rollback", async () =>
    {
        const rolledBack = new KnexPgUnitOfWork(dbConnectionFactory);
        await repository().saveWithin(entry({ id: "led_rb", sequence: 51 }), rolledBack);
        await rolledBack.rollback();
        await assert.rejects(() => repository().get("led_rb"), ReadModelNotFoundException);

        const committed = new KnexPgUnitOfWork(dbConnectionFactory);
        await repository().saveWithin(entry({ id: "led_cm", sequence: 52 }), committed);
        await committed.commit();
        assert.strictEqual((await repository().get("led_cm")).id, "led_cm");
    });

    await test("a batch of 1200 rows round-trips through saveAllWithin, and a second batch updates in place", async () =>
    {
        await db.executeCommand(`delete from ${T};`);

        const batch = Array.from({ length: 1200 }, (_, i) =>
            entry({ id: `led_batch${i}`, account: `acc_batch${i % 3}`, amount: i, postedAt: 1700000000000 + i * 1000, sequence: 5000 + i, labels: [`b${i % 5}`] }));

        const unitOfWork = new KnexPgUnitOfWork(dbConnectionFactory);
        await repository().saveAllWithin(batch, unitOfWork);
        await unitOfWork.commit();

        assert.strictEqual(await repository().countAll(), 1200);
        const row = await repository().get("led_batch777");
        assert.strictEqual(row.amount, 777);
        assert.strictEqual(row.postedAt, 1700000000000 + 777 * 1000);
        assert.deepStrictEqual(row.labels, ["b2"]);

        await repository().saveAll(batch.map(t => entry({ id: t.id, account: t.account, amount: t.amount + 1, postedAt: t.postedAt, sequence: t.sequence, labels: t.labels })));

        assert.strictEqual(await repository().countAll(), 1200);
        assert.strictEqual((await repository().get("led_batch777")).amount, 778);

        const rolledBack = new KnexPgUnitOfWork(dbConnectionFactory);
        await repository().saveAllWithin([entry({ id: "led_batch_rb", sequence: 9999 })], rolledBack);
        await rolledBack.rollback();
        await assert.rejects(() => repository().get("led_batch_rb"), ReadModelNotFoundException);
    });

    await test("the table verifies clean against the declaration it was created from", async () =>
    {
        assert.deepStrictEqual(await new ReadModelTableCreator(db, logger).verifyReadModelTable(LedgerEntryRepository.schema), []);
    });
});
