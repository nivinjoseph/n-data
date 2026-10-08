import { Logger } from "@nivinjoseph/n-log";
import { Db } from "../db/db.js";
import { AnyReadModel } from "./read-model.js";
import { IntactReadModelSchema, ReadModelColumnInfo, ReadModelIndexInfo } from "./read-model-schema.js";
/**
 * The result of creating a read model table.
 */
export interface ReadModelTableInfo {
    readonly tableName: string;
    /**
     * The declared columns, in the order they were emitted.
     */
    readonly columns: ReadonlyArray<ReadModelColumnInfo>;
    /**
     * The indexes as created, in declaration order.
     */
    readonly createdIndexes: ReadonlyArray<ReadModelIndexInfo>;
}
/**
 * One divergence between a read model schema and what a database was actually provisioned with,
 * found by {@link ReadModelTableCreator.verifyReadModelTable}.
 *
 * Creation is `if not exists`, which never reconciles - so a declaration changed after its migration
 * ran leaves the database as it was while every query still compiles. The failure modes differ from
 * the snapshot side's: a column the table lacks raises `column does not exist` on the first read
 * rather than scanning silently, and a column of another type coerces or fails per value. Both are
 * detectable here.
 *
 * `severity` follows the library's rule: a `fatal` issue is definite drift between this declaration
 * and this database; an `advisory` is ambiguous or possibly deliberate - a hand-added `not null` is
 * legitimate hardening, an orphan column may be a property the application is migrating away from.
 */
export interface ReadModelDriftIssue {
    readonly tableName: string;
    /**
     * The column the issue is about; absent for the table-level and index kinds.
     */
    readonly columnName?: string;
    /**
     * The index the issue is about; absent for the table-level and column kinds.
     */
    readonly indexName?: string;
    /**
     * - `table-missing`: the migration that creates the table never ran here.
     * - `column-missing`: a declared column the table lacks - a property added after the migration
     *   ran. The fix is the add-column statement; re-running the create emits it too.
     * - `column-type-mismatch`: the column exists at another type. No fix: a type change needs an
     *   `alter column ... type ... using` with a cast decision a canned statement would get wrong.
     * - `column-not-null`: a hand-added `not null` constraint. Every column this creator emits is
     *   nullable, so a save of NULL would fail there; left in place because it may be deliberate.
     * - `index-missing` / `index-uniqueness-mismatch` / `index-method-mismatch` /
     *   `index-columns-mismatch`: as on the snapshot side - an index absent, or existing under the
     *   declared name but not the declared index.
     * - `index-definition-mismatch`: the right columns, but a partial index (a `WHERE`), an opclass
     *   or an ordering the declaration does not produce - visible only in the full definition, since
     *   the per-column catalog form prints the bare column. Fixed by drop and recreate.
     * - `orphan-index`: an index following this class's `idx_<table>` naming that no declaration
     *   produces.
     * - `orphan-column`: a column no declaration produces - a property removed from the model, or a
     *   hand-added one. Never dropped automatically.
     */
    readonly kind: "table-missing" | "column-missing" | "column-type-mismatch" | "column-not-null" | "index-missing" | "index-uniqueness-mismatch" | "index-method-mismatch" | "index-columns-mismatch" | "index-definition-mismatch" | "orphan-index" | "orphan-column";
    readonly severity: "fatal" | "advisory";
    /**
     * Names the problem and the fix, so a logged issue is actionable on its own.
     */
    readonly message: string;
    /**
     * Executable DDL that remedies the issue - present only on a `fatal` issue whose remedy is a
     * statement: `alter table ... add column if not exists` for a missing column, `create index ...`
     * for a missing index, `drop index if exists ...; create ...` for a mismatched one. Absent on
     * `table-missing` (run the creating migration), `column-type-mismatch` (a cast decision), and
     * every advisory.
     */
    readonly fix?: string;
}
/**
 * What a {@link ReadModelTableCreator.reconcileReadModelTable} call did, and what it left.
 */
export interface ReadModelReconcileResult {
    readonly tableName: string;
    /**
     * The fatal issues whose {@link ReadModelDriftIssue.fix} was executed, in the order they ran:
     * columns first, then indexes.
     */
    readonly fixed: ReadonlyArray<ReadModelDriftIssue>;
    /**
     * What the closing verify still reports: advisories, and fatals with no mechanical fix. Empty
     * means the database now matches the declaration exactly.
     */
    readonly remaining: ReadonlyArray<ReadModelDriftIssue>;
}
/**
 * Creates, verifies and reconciles read model tables from a {@link ReadModelSchema}.
 *
 * A sibling of `DbTableCreator` rather than part of it: that class's contract is that nothing in it
 * alters a table, while this one must - a read model's shape is its columns, and a property added
 * later is an `alter table add column`. Constructed by hand in a migration, exactly as the other is.
 *
 * Creation is idempotent and additive. The table is `create ... if not exists`; then every declared
 * column is `add column if not exists`, so a column added to the schema after the table's migration
 * ran only needs the migration re-run - the same idiom as adding a snapshot index path; then every
 * index is `create index if not exists`. **Every column is nullable** - no `not null` is ever
 * emitted - so a column added on day 2 is indistinguishable from one created on day 1, and nothing
 * here needs a backfill decision.
 *
 * What `if not exists` does *not* do is reconcile: a column whose declared type changed, or an
 * index whose uniqueness did, keeps its old definition under the old name. {@link verifyReadModelTable}
 * detects every such divergence and {@link reconcileReadModelTable} runs the ones a statement can
 * fix.
 *
 * @example
 * ```typescript
 * @inject("Db", "Logger")
 * export class AppDbMigration_5 implements DbMigration
 * {
 *     public async execute(): Promise<void>
 *     {
 *         await new ReadModelTableCreator(this._db, this._logger).createReadModelTable(PgOrderSummaryRepository.schema);
 *     }
 * }
 *
 * // in an integration test - the same object, so drift has a detector
 * assert.deepStrictEqual(await creator.verifyReadModelTable(PgOrderSummaryRepository.schema), []);
 * ```
 *
 * @class ReadModelTableCreator
 */
export declare class ReadModelTableCreator {
    private readonly _db;
    private readonly _logger;
    /**
     * @param {Db} db - The writable database used to execute the DDL.
     * @param {Logger} logger - The logger used to record each creation and fix.
     */
    constructor(db: Db, logger: Logger);
    /**
     * Reads the schema once and produces everything derived from it. The table name was validated at
     * declaration; it is validated again here because this is where it meets DDL.
     */
    private static _plan;
    /**
     * Compares the expected indexes against what the catalog holds, name by name. A plain column
     * prints as its bare name in `pg_get_indexdef(oid, n, true)`, which is what makes the column
     * comparison exact here where the snapshot side can only test token containment.
     */
    private static _compareIndexes;
    /**
     * The read model side's column comparison. A plain column prints as its bare name in
     * `pg_get_indexdef(oid, n, true)`, which makes the per-column check exact - but that per-column
     * form prints *only* the column: an opclass, a `DESC`, or a partial index's `WHERE` live in the
     * full definition alone, so the column list in it is compared textually as well.
     */
    private static _compareIndexColumns;
    /**
     * Creates the read model's table, adds any declared column it lacks, and creates its indexes -
     * each statement idempotent, so this is safe to run on every migration.
     *
     * @template T - The read model.
     * @param {IntactReadModelSchema<T>} schema - The repository's declaration, normally its `schema` static. Typed through the intact brand, like every consumer of a schema, so one widened to `ReadModelSchema<any>` is refused here.
     * @returns {Promise<ReadModelTableInfo>} The table and indexes as created.
     * @throws {ArgumentNullException} If schema is null or undefined.
     * @throws {ArgumentException} If schema is not a ReadModelSchema, or the table name is invalid.
     * @throws {DbException} If a statement fails.
     */
    createReadModelTable<T extends AnyReadModel>(schema: IntactReadModelSchema<T>): Promise<ReadModelTableInfo>;
    /**
     * Compares the schema against the database and reports every divergence. Touches nothing.
     *
     * Run it at the tail of a migration run and throw on `fatal`, or assert it empty in an
     * integration test - the same idiom as `DbTableCreator.verifySnapshotTableForAggregate`.
     *
     * @template T - The read model.
     * @param {IntactReadModelSchema<T>} schema - The same declaration the create call takes.
     * @returns {Promise<ReadonlyArray<ReadModelDriftIssue>>} Every divergence found, or empty.
     * @throws {ArgumentException} If schema is not a ReadModelSchema.
     * @throws {DbException} If a catalog query fails.
     */
    verifyReadModelTable<T extends AnyReadModel>(schema: IntactReadModelSchema<T>): Promise<ReadonlyArray<ReadModelDriftIssue>>;
    /**
     * Verifies, executes every fix the fatal issues carry - missing columns first, then indexes,
     * each as one atomic command - and verifies again.
     *
     * Never alters a column's type or nullability, never drops a column, and never touches an
     * advisory. Refuses to act on a missing table: that means the creating migration has not run,
     * and reconciling past it would stand in for migration history. Migration-time only - index
     * builds block writes.
     *
     * @template T - The read model.
     * @param {IntactReadModelSchema<T>} schema - The same declaration the create call takes.
     * @returns {Promise<ReadModelReconcileResult>} What was fixed, and what the closing verify still reports.
     * @throws {ArgumentException} If schema is not a ReadModelSchema.
     * @throws {DbException} If a catalog query or an executed fix fails; fixes already executed stand.
     */
    reconcileReadModelTable<T extends AnyReadModel>(schema: IntactReadModelSchema<T>): Promise<ReadModelReconcileResult>;
    private _planOf;
    private _verify;
    /**
     * Reads a table's columns from `pg_catalog` rather than `information_schema`, whose `data_type`
     * prints `ARRAY` for every array column. `format_type` prints the spelling {@link catalogTypeOf}
     * compares against. Empty means the table does not exist.
     */
    private _fetchColumns;
}
//# sourceMappingURL=read-model-table-creator.d.ts.map