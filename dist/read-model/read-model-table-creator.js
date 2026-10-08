import { given } from "@nivinjoseph/n-defensive";
import { compareIndexes, createFixDdl, createIndexDdl, fetchTableIndexes, validateTableName } from "../migration/table-ddl.js";
import { catalogTypeOf } from "./column-type.js";
import { ReadModelSchema } from "./read-model-schema.js";
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
export class ReadModelTableCreator {
    _db;
    _logger;
    /**
     * @param {Db} db - The writable database used to execute the DDL.
     * @param {Logger} logger - The logger used to record each creation and fix.
     */
    constructor(db, logger) {
        given(db, "db").ensureHasValue().ensureIsObject();
        this._db = db;
        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;
    }
    /**
     * Reads the schema once and produces everything derived from it. The table name was validated at
     * declaration; it is validated again here because this is where it meets DDL.
     */
    static _plan(schema) {
        const tableName = validateTableName(schema.table);
        const columns = [
            { column: "id", ddlType: "varchar(40)", catalogType: "character varying(40)" },
            ...schema.columns.map(t => ({ column: t.column, key: t.key, ddlType: t.type, catalogType: catalogTypeOf(t.type) }))
        ];
        const tableIndexes = schema.indexes.map(t => t.method === "gin"
            ? { name: t.name, columns: t.columns, method: "gin" }
            : { name: t.name, columns: t.columns, isUnique: t.isUnique });
        const expectedIndexes = schema.indexes.map((t, i) => ({
            name: t.name, isUnique: t.isUnique, method: t.method, columns: t.columns, ddl: createIndexDdl(tableName, tableIndexes[i])
        }));
        return { tableName, columns, tableIndexes, expectedIndexes };
    }
    /**
     * Compares the expected indexes against what the catalog holds, name by name. A plain column
     * prints as its bare name in `pg_get_indexdef(oid, n, true)`, which is what makes the column
     * comparison exact here where the snapshot side can only test token containment.
     */
    static _compareIndexes(tableName, expected, actual) {
        return compareIndexes(tableName, expected, actual, {
            missing: exp => ({
                tableName, indexName: exp.name, kind: "index-missing", severity: "fatal", fix: exp.ddl,
                message: `index '${exp.name}' is declared but does not exist - the declaration was added after the table's migration ran; re-run the create, or run: ${exp.ddl}`
            }),
            methodMismatch: (exp, act) => ({
                tableName, indexName: exp.name, kind: "index-method-mismatch", severity: "fatal", fix: createFixDdl(exp),
                message: `index '${exp.name}' is a ${act.method} index in the database but is declared ${exp.method} - it answers none of the declared predicates; fix: ${createFixDdl(exp)}`
            }),
            uniquenessMismatch: exp => ({
                tableName, indexName: exp.name, kind: "index-uniqueness-mismatch", severity: "fatal", fix: createFixDdl(exp),
                message: exp.isUnique
                    ? `index '${exp.name}' is declared unique but the database's is not - nothing enforces the natural key; fix: ${createFixDdl(exp)}`
                    : `index '${exp.name}' is unique in the database but is not declared so - it still constrains every write; fix: ${createFixDdl(exp)}`
            }),
            columns: (exp, act) => ReadModelTableCreator._compareIndexColumns(tableName, exp, act),
            orphan: act => ({
                tableName, indexName: act.indexName, kind: "orphan-index", severity: "advisory",
                message: `index '${act.indexName}' is not produced by this declaration - the residue of a changed declaration, or a hand-built index; nothing here drops - drop it in a hand-written migration if unintended`
            })
        });
    }
    /**
     * The read model side's column comparison. A plain column prints as its bare name in
     * `pg_get_indexdef(oid, n, true)`, which makes the per-column check exact - but that per-column
     * form prints *only* the column: an opclass, a `DESC`, or a partial index's `WHERE` live in the
     * full definition alone, so the column list in it is compared textually as well.
     */
    static _compareIndexColumns(tableName, exp, act) {
        const fix = createFixDdl(exp);
        if (act.columnCount !== exp.columns.length || exp.columns.some((column, i) => act.columnDefs[i] !== column))
            return [{
                    tableName, indexName: exp.name, kind: "index-columns-mismatch", severity: "fatal", fix,
                    message: `index '${exp.name}' covers (${act.columnDefs.join(", ")}) in the database but is declared over (${exp.columns.join(", ")}); fix: ${fix}`
                }];
        const declaredList = exp.columns.join(", ");
        const definedList = / using \w+ \((.*?)\)(?: where .*)?$/i.exec(act.indexDef)?.[1] ?? null;
        const isPartial = / where /i.test(act.indexDef);
        if (!isPartial && definedList === declaredList)
            return [];
        return [{
                tableName, indexName: exp.name, kind: "index-definition-mismatch", severity: "fatal", fix,
                message: isPartial
                    ? `index '${exp.name}' is a partial index (its definition carries a WHERE) where the declaration covers every row - predicates outside its predicate cannot use it; fix: ${fix}`
                    : `index '${exp.name}' is defined over (${definedList ?? act.indexDef}) where the declaration produces (${declaredList}) - an opclass or an ordering changes what the index serves; fix: ${fix}`
            }];
    }
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
    async createReadModelTable(schema) {
        const plan = this._planOf(schema);
        const declared = plan.columns.where(t => t.key != null);
        await this._db.executeCommand(`
            create table if not exists ${plan.tableName}
            (
                id varchar(40) primary key,
                ${declared.map(t => `${t.column} ${t.ddlType}`).join(",\n                ")}
            );
        `);
        // one statement per column, every run: a column added after the table existed is created
        // here, and a DbException names the column it failed on
        for (const column of declared)
            await this._db.executeCommand(`alter table ${plan.tableName} add column if not exists ${column.column} ${column.ddlType};`);
        for (const index of plan.tableIndexes)
            await this._db.executeCommand(createIndexDdl(plan.tableName, index));
        await this._logger.logInfo(`TABLE CREATED [${plan.tableName}]`);
        return { tableName: plan.tableName, columns: schema.columns, createdIndexes: schema.indexes };
    }
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
    verifyReadModelTable(schema) {
        return this._verify(this._planOf(schema));
    }
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
    async reconcileReadModelTable(schema) {
        const plan = this._planOf(schema);
        const issues = await this._verify(plan);
        if (issues.some(t => t.kind === "table-missing"))
            return { tableName: plan.tableName, fixed: [], remaining: issues };
        const fixed = new Array();
        // issues arrive columns first, so a column an index needs exists before the index is built
        for (const issue of issues) {
            if (issue.fix == null)
                continue;
            await this._db.executeCommand(issue.fix);
            await this._logger.logInfo(`RECONCILED [${issue.indexName ?? issue.columnName}] via: ${issue.fix}`);
            fixed.push(issue);
        }
        const remaining = await this._verify(plan);
        return { tableName: plan.tableName, fixed, remaining };
    }
    _planOf(schema) {
        // guards a plain object arriving from JavaScript, where the builder is unenforced
        given(schema, "schema").ensureHasValue().ensureIsObject().ensureIsInstanceOf(ReadModelSchema);
        return ReadModelTableCreator._plan(schema);
    }
    async _verify(plan) {
        const issues = new Array();
        const tableName = plan.tableName;
        const actualColumns = await this._fetchColumns(tableName);
        if (actualColumns.isEmpty) {
            issues.push({
                tableName, kind: "table-missing", severity: "fatal",
                message: `table '${tableName}' does not exist in this database - the migration that creates it has not run here, and every read of it will raise 'relation does not exist'`
            });
            return issues;
        }
        const actualByName = new Map(actualColumns.map(t => [t.columnName, t]));
        for (const expected of plan.columns) {
            const actual = actualByName.get(expected.column);
            if (actual == null) {
                const fix = `alter table ${tableName} add column if not exists ${expected.column} ${expected.ddlType};`;
                issues.push(expected.key != null
                    ? {
                        tableName, columnName: expected.column, kind: "column-missing", severity: "fatal", fix,
                        message: `column '${expected.column}' (key '${expected.key}') is declared but does not exist - the property was added after the table's migration ran, and every read will raise 'column does not exist'; re-run the create, or run: ${fix}`
                    }
                    : {
                        tableName, columnName: expected.column, kind: "column-missing", severity: "fatal",
                        message: `table '${tableName}' has no 'id' column - it was not created by this creator`
                    });
                continue;
            }
            if (actual.dataType !== expected.catalogType) {
                issues.push({
                    tableName, columnName: expected.column, kind: "column-type-mismatch", severity: "fatal",
                    message: `column '${expected.column}' is '${actual.dataType}' in the database but is declared '${expected.catalogType}' - values will coerce or fail per row; change the type in a hand-written migration with an 'alter column ... type ... using' cast, or change the declaration back`
                });
                continue;
            }
            if (actual.isNotNull && expected.key != null)
                issues.push({
                    tableName, columnName: expected.column, kind: "column-not-null", severity: "advisory",
                    message: `column '${expected.column}' is not null in the database, which this creator never emits - a save of a null '${expected.key}' will fail there; deliberate hardening is legitimate, so nothing here changes it`
                });
        }
        const expectedNames = new Set(plan.columns.map(t => t.column));
        for (const actual of actualColumns) {
            if (expectedNames.has(actual.columnName))
                continue;
            issues.push({
                tableName, columnName: actual.columnName, kind: "orphan-column", severity: "advisory",
                message: `column '${actual.columnName}' is not produced by this declaration - a property removed from the model, or a hand-added column; it is ignored on every read and write, and nothing here drops it`
            });
        }
        issues.push(...ReadModelTableCreator._compareIndexes(tableName, plan.expectedIndexes, await fetchTableIndexes(this._db, tableName)));
        return issues;
    }
    /**
     * Reads a table's columns from `pg_catalog` rather than `information_schema`, whose `data_type`
     * prints `ARRAY` for every array column. `format_type` prints the spelling {@link catalogTypeOf}
     * compares against. Empty means the table does not exist.
     */
    async _fetchColumns(tableName) {
        const result = await this._db.executeQuery(`
            select a.attname as "columnName", format_type(a.atttypid, a.atttypmod) as "dataType", a.attnotnull as "isNotNull"
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            join pg_namespace n on n.oid = c.relnamespace
            where c.relname = ? and n.nspname = current_schema() and a.attnum > 0 and not a.attisdropped
            order by a.attnum;
        `, tableName);
        return result.rows;
    }
}
//# sourceMappingURL=read-model-table-creator.js.map