import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "../repository/data-helper.js";
import { SnapshotArrayIndex } from "./snapshot-array-index.js";
import { JsonValueType, SnapshotIndex } from "./snapshot-index.js";
/**
 * Creates the database tables and indexes used by the event-sourcing infrastructure.
 *
 * For each aggregate type this can provision an event-stream table (the append-only log
 * of domain events) and a snapshot table (the materialized current state). Separate
 * methods exist for plain aggregates and organization-scoped aggregates; the latter add
 * an `organization_id` column and include it in the leading position of their indexes.
 *
 * All table and index creation is idempotent (`if not exists`), so the methods are safe
 * to invoke on every startup/migration run. Note that `if not exists` does not *reconcile*:
 * an existing table keeps its columns and an existing index keeps its definition, since it
 * matches on name alone. Changing what a table or index is declared to be therefore takes a
 * migration of its own - nothing here alters or drops.
 *
 * @class DbTableCreator
 */
export class DbTableCreator {
    /**
     * Maximum identifier length Postgres permits before silently truncating.
     * Postgres truncates identifiers to NAMEDATALEN - 1 = 63 bytes.
     */
    static _maxIdentifierLength = 63;
    /**
     * An unquoted Postgres identifier that needs no folding: lowercase, digits, underscores.
     * Anything else would either be truncated, folded, or change the statement's meaning
     * once interpolated into DDL.
     */
    static _identifierRegex = /^[a-z_][a-z0-9_]*$/;
    /**
     * The prefix every index name carries. Its length is the budget a derived table name must leave
     * free, so an index name composed over it can still fit.
     */
    static _indexNamePrefix = "idx_";
    _db;
    _logger;
    /**
     * Creates a new DbTableCreator.
     *
     * @param {Db} db - The writable database used to execute the DDL commands.
     * @param {Logger} logger - The logger used to record each table creation.
     */
    constructor(db, logger) {
        given(db, "db").ensureHasValue().ensureIsObject();
        this._db = db;
        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;
    }
    /**
     * Compares the expected indexes against what the catalog holds, name by name; pure and
     * synchronous, so it is testable against fabricated rows.
     *
     * Matching is structural - name, uniqueness, method, column count, per-column result type, and a
     * path token per expression column - never a comparison of definition text, which Postgres
     * normalizes freely. `format_type` prints the {@link JsonValueType} members' own spellings
     * (`numeric`, `uuid`, `double precision`, ...), so the cast check is byte-exact; an uncast
     * extraction and a declared `text` cast both index as `text`, the one documented equivalence
     * (Postgres elides a redundant `::text`).
     *
     * Leftover indexes carrying this class's `idx_<table>` prefix are reported as advisory orphans -
     * advisory rather than fatal because a hand-built index under the convention is legitimate (the
     * docs themselves recommend a `text_pattern_ops` index for prefix `LIKE`), and the primary key
     * never matches, being named `<table>_pkey`.
     *
     * @param {string} tableName - The table both sides describe.
     * @param {ReadonlyArray<ExpectedIndex>} expected - What the declarations produce.
     * @param {ReadonlyArray<ActualTableIndex>} actual - What the catalog holds.
     * @returns {Array<SnapshotDriftIssue>} Every divergence, most severe first within each index.
     */
    static _compareIndexes(tableName, expected, actual) {
        const issues = new Array();
        const actualByName = new Map(actual.map(t => [t.indexName, t]));
        const expectedNames = new Set(expected.map(t => t.name));
        for (const exp of expected) {
            const act = actualByName.get(exp.name);
            if (act == null) {
                issues.push({
                    tableName, indexName: exp.name, kind: "index-missing", severity: "fatal",
                    message: `index '${exp.name}' does not exist - a declaration with no matching migration run against this database, so queries on [${exp.paths.join(", ")}] sequential-scan while looking indexed; create it with: ${exp.ddl}`,
                    fix: exp.ddl
                });
                continue;
            }
            if (act.method !== exp.method) {
                issues.push({
                    tableName, indexName: exp.name, kind: "index-method-mismatch", severity: "fatal",
                    message: `index '${exp.name}' uses ${act.method} where the declaration produces ${exp.method} - it cannot serve the declared predicates; drop it in a hand-written migration and re-run the create`,
                    fix: DbTableCreator._createFixDdl(exp)
                });
                // the shape checks below compare within one access method; against the wrong one
                // they would only restate this issue in smaller pieces
                continue;
            }
            if (act.isUnique !== exp.isUnique)
                issues.push({
                    tableName, indexName: exp.name, kind: "index-uniqueness-mismatch", severity: "fatal",
                    message: exp.isUnique
                        ? `index '${exp.name}' is not unique where the declaration says unique - the constraint is not being enforced; drop it in a hand-written migration and re-run the create`
                        : `index '${exp.name}' is unique where the declaration is not - a uniqueness constraint is being enforced that nothing declares; drop it in a hand-written migration and re-run the create`,
                    fix: DbTableCreator._createFixDdl(exp)
                });
            const expectedColumnCount = (exp.leadingColumn != null ? 1 : 0) + exp.expressions.length;
            if (act.columnCount !== expectedColumnCount) {
                issues.push({
                    tableName, indexName: exp.name, kind: "index-columns-mismatch", severity: "fatal",
                    message: `index '${exp.name}' has ${act.columnCount} column(s) where the declaration produces ${expectedColumnCount} - drop it in a hand-written migration and re-run the create`,
                    fix: DbTableCreator._createFixDdl(exp)
                });
                continue;
            }
            if (exp.leadingColumn != null && act.columnDefs[0] !== exp.leadingColumn) {
                issues.push({
                    tableName, indexName: exp.name, kind: "index-columns-mismatch", severity: "fatal",
                    message: `index '${exp.name}' does not lead with '${exp.leadingColumn}' - org-scoped predicates constrain that column first and cannot use the index without it; drop it in a hand-written migration and re-run the create`,
                    fix: DbTableCreator._createFixDdl(exp)
                });
                continue;
            }
            const offset = exp.leadingColumn != null ? 1 : 0;
            exp.paths.forEach((path, i) => {
                const columnType = act.columnTypes[offset + i];
                const columnDef = act.columnDefs[offset + i];
                // btree only: a btree attribute carries the indexed expression's result type, which
                // is what a cast is. A GIN attribute carries the *opclass storage* type instead
                // (int4 hashes for jsonb_path_ops, text for jsonb_ops - verified against Postgres),
                // so for GIN the method, opclass and token checks are the whole comparison
                if (exp.method === "btree") {
                    const expectedType = exp.casts[i] ?? JsonValueType.text;
                    if (columnType !== expectedType) {
                        issues.push({
                            tableName, indexName: exp.name, kind: "index-cast-mismatch", severity: "fatal",
                            message: `index '${exp.name}' extracts '${path}' as ${columnType} where the declaration casts to ${expectedType} - the predicate expression cannot match the indexed one, so queries on it sequential-scan while looking indexed; drop the index in a hand-written migration and re-run the create`,
                            fix: DbTableCreator._createFixDdl(exp)
                        });
                        // a type mismatch usually means a different expression altogether; the token
                        // check would double-report the same drift
                        return;
                    }
                }
                // the token comes from the path rather than the expression: pg_get_indexdef prints
                // a single segment as 'segment' and a walked path as '{a,b}' (unquoted, unspaced)
                const segments = path.split(".");
                const token = segments.length === 1 ? `'${segments[0]}'` : `{${segments.join(",")}}`;
                if (!columnDef.contains(token))
                    issues.push({
                        tableName, indexName: exp.name, kind: "index-expression-mismatch", severity: "fatal",
                        message: `index '${exp.name}' column ${offset + i + 1} does not read path '${path}' - the indexed expression is not the declared one; drop the index in a hand-written migration and re-run the create`,
                        fix: DbTableCreator._createFixDdl(exp)
                    });
            });
            if (exp.method === "gin" && !act.indexDef.contains(SnapshotArrayIndex.opclass))
                issues.push({
                    tableName, indexName: exp.name, kind: "index-opclass-mismatch", severity: "advisory",
                    message: `index '${exp.name}' is gin but not over ${SnapshotArrayIndex.opclass} - containment still works, but the index is larger and slower than the declared one`
                });
        }
        const orphanPrefix = `${DbTableCreator._indexNamePrefix}${tableName}`;
        for (const act of actual) {
            if (expectedNames.has(act.indexName) || !act.indexName.startsWith(orphanPrefix))
                continue;
            issues.push({
                tableName, indexName: act.indexName, kind: "orphan-index", severity: "advisory",
                message: act.isUnique
                    ? `index '${act.indexName}' is not produced by these declarations, and it is unique - it still constrains every row written to this table, so if a 'unique' was cleared from a declaration this is the index that keeps enforcing it; nothing here drops - drop it in a hand-written migration, or ignore it if deliberate`
                    : act.indexName.endsWith("_gin")
                        ? `index '${act.indexName}' is not produced by these declarations - likely the residue of a path no longer array-indexed; nothing here drops - drop it in a hand-written migration, or ignore it if deliberate`
                        : `index '${act.indexName}' is not produced by these declarations - the residue of a changed declaration, or a hand-built index (a 'text_pattern_ops' index for prefix LIKE is a legitimate one); nothing here drops - drop it in a hand-written migration if unintended`
            });
        }
        return issues;
    }
    /**
     * The one place an index's DDL is rendered - {@link _createTable} emits it, and the plan carries
     * it for the `index-missing` message, so the fix a verify issue names is the statement creation
     * would run.
     *
     * @param {string} tableName - The validated table name.
     * @param {TableIndex} index - The index definition.
     * @returns {string} The `create index` statement.
     */
    static _createIndexDdl(tableName, index) {
        return `create ${index.isUnique === true ? "unique " : ""}index if not exists ${index.name} on ${tableName}${index.method != null ? ` using ${index.method}` : ""}(${index.columns.join(", ")});`;
    }
    /**
     * The remedy for an index that exists under the declared name but is not the declared index:
     * drop it, then run the same statement creation would - the {@link ExpectedIndex.ddl} the plan
     * already carries, so the recreate provably matches what a fresh migration would build.
     *
     * @param {ExpectedIndex} expected - The index the declaration produces.
     * @returns {string} The two-statement fix.
     */
    static _createFixDdl(expected) {
        return `drop index if exists ${expected.name}; ${expected.ddl}`;
    }
    /**
     * Creates the event-stream table and its index for a plain aggregate.
     *
     * The table stores the append-only sequence of domain events for the aggregate, keyed
     * by event `id`. A unique index on `(aggregate_id, aggregate_version)` enforces
     * optimistic-concurrency control by preventing two events from sharing the same version
     * for a given aggregate. The table name is derived via {@link DataHelper.createEventStreamTableName}.
     *
     * @param {AggregateRootClass} aggregateType - The aggregate class whose event-stream table is created.
     * @returns {Promise<string>} A promise that resolves to the created table's name once the table and index exist.
     * @throws {ArgumentNullException} If aggregateType is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, or the derived table or index name is not a valid Postgres identifier or exceeds the identifier limit.
     * @throws {DbException} If a DDL command fails.
     */
    async createEventStreamTableForAggregate(aggregateType) {
        const tableName = this._validateTableName(DataHelper.createEventStreamTableName(aggregateType));
        await this._createTable(tableName, [
            "id varchar(50) primary key",
            "aggregate_id varchar(40) not null",
            "aggregate_version integer not null",
            "data jsonb not null"
        ], [{
                name: this.createIndexNameFromTableName(tableName),
                columns: ["aggregate_id", "aggregate_version"],
                isUnique: true
            }]);
        return tableName;
    }
    /**
     * Creates the event-stream table and its index for an organization-scoped aggregate.
     *
     * Identical to {@link createEventStreamTableForAggregate} but adds a non-null
     * `organization_id` column, and the unique index covers
     * `(organization_id, aggregate_id, aggregate_version)` so concurrency is enforced
     * per aggregate within an organization.
     *
     * @param {OrgAggregateRootClass} aggregateType - The org-scoped aggregate class whose event-stream table is created.
     * @returns {Promise<string>} A promise that resolves to the created table's name once the table and index exist.
     * @throws {ArgumentNullException} If aggregateType is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, or the derived table or index name is not a valid Postgres identifier or exceeds the identifier limit.
     * @throws {DbException} If a DDL command fails.
     */
    async createEventStreamTableForOrgAggregate(aggregateType) {
        const tableName = this._validateTableName(DataHelper.createEventStreamTableName(aggregateType));
        await this._createTable(tableName, [
            "id varchar(50) primary key",
            "aggregate_id varchar(40) not null",
            "aggregate_version integer not null",
            "organization_id varchar(40) not null",
            "data jsonb not null"
        ], [{
                name: this.createIndexNameFromTableName(tableName),
                columns: ["organization_id", "aggregate_id", "aggregate_version"],
                isUnique: true
            }]);
        return tableName;
    }
    /**
     * Creates the snapshot table for a plain aggregate.
     *
     * The snapshot table holds the latest materialized state of each aggregate, keyed by its
     * `id` (the primary key, which is already indexed - so no index over `id` is created).
     * The table name is derived via {@link DataHelper.createSnapshotTableName}.
     *
     * Each entry in `indexes` produces one expression index over the keys it names inside `data`; no
     * column is added. Each entry in `arrayIndexes` produces a GIN containment index over the array
     * as jsonb, which is what answers membership questions of it. Omit the argument entirely for a
     * table with no indexes at all.
     *
     * `TState` is inferred from `aggregateType`, so every index's paths are checked against the
     * aggregate's real state shape.
     *
     * **Prefer passing the repository's `SnapshotQuerySet`.** It carries both kinds of declaration and
     * is the same object the repository builds its predicates from, so an index that is queried is
     * necessarily one that was created. It satisfies `SnapshotTableOptions` by shape - `indexes` and
     * `arrayIndexes` are exactly its two getters - so it needs no unwrapping here.
     *
     * The bare array of `SnapshotIndex` this used to accept is gone, and both fields of the options
     * object are now required: that form had nowhere to put array indexes, so handing over
     * `querySet.indexes` created every btree index, silently omitted every GIN one, and left
     * `contains` sequential-scanning with nothing failing at migration time. Declaring btree indexes
     * and no array ones is still perfectly legal - it is now spelt `arrayIndexes: []`, which says so.
     *
     * @param {AggregateRootClassOf<TState>} aggregateType - The aggregate class whose snapshot table is created.
     * @param {SnapshotTableOptions<TState>} [options] - A repository's `SnapshotQuerySet`, or the two index collections. Omit for no indexes.
     * @returns {Promise<SnapshotTableInfo>} A promise that resolves to the table's name and the indexes as created.
     * @throws {ArgumentNullException} If aggregateType is null or undefined, or an element of either collection is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, the derived table or index name is invalid, or the indexes are invalid or duplicated.
     * @throws {DbException} If a DDL command fails.
     */
    async createSnapshotTableForAggregate(aggregateType, options) {
        const tableName = this._validateTableName(DataHelper.createSnapshotTableName(aggregateType));
        const plan = this._planSnapshotTable(tableName, options);
        await this._createTable(tableName, [
            "id varchar(40) primary key",
            "data jsonb not null"
        ], plan.tableIndexes);
        return { tableName, createdIndexes: plan.infos };
    }
    /**
     * Creates the snapshot table and its index for an organization-scoped aggregate.
     *
     * Like {@link createSnapshotTableForAggregate} but adds a non-null `organization_id`
     * column, and every index leads with it because `OrgSnapshotBaseRepository` requires every query
     * to constrain it - `get` and `getAll` do so themselves, and `query` obliges the caller to.
     *
     * When no btree `indexes` are given, an index over `(organization_id)` is created to support
     * org-scoped scans. When there are, each of them already leads with `organization_id`,
     * making a standalone one a strict subset of an index being built anyway - so it is skipped.
     * That is sound rather than merely plausible: constraining a leading column alone does use the
     * composite index, which is verified against Postgres by a planner test.
     *
     * An `arrayIndexes` declaration does **not** count towards that: a GIN index cannot lead with
     * `organization_id`, because a multicolumn GIN over a varchar column needs the `btree_gin`
     * extension, which is not trusted on Postgres 12 and would demand superuser at migration time. So
     * a table whose only indexes are array ones still gets the standalone `(organization_id)` index -
     * both to serve a plain org-scoped scan, and to give the planner something to BitmapAnd the GIN
     * scan against.
     *
     * `TState` is inferred from `aggregateType`, so every index's paths are checked against the
     * aggregate's real state shape.
     *
     * **Prefer passing the repository's `SnapshotQuerySet`**, for the same reason as on the plain
     * variant: it is the object the repository queries through, so a declared index and a created one
     * cannot diverge. Both fields of the options object are required for the reason given there.
     *
     * @param {OrgAggregateRootClassOf<TState>} aggregateType - The org-scoped aggregate class whose snapshot table is created.
     * @param {SnapshotTableOptions<TState>} [options] - A repository's `SnapshotQuerySet`, or the two index collections. Omit for no indexes.
     * @returns {Promise<SnapshotTableInfo>} A promise that resolves to the table's name and the indexes as created.
     * @throws {ArgumentNullException} If aggregateType is null or undefined, or an element of either collection is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, the derived table or index name is invalid, or the indexes are invalid or duplicated.
     * @throws {DbException} If a DDL command fails.
     */
    async createSnapshotTableForOrgAggregate(aggregateType, options) {
        const tableName = this._validateTableName(DataHelper.createSnapshotTableName(aggregateType));
        const plan = this._planSnapshotTable(tableName, options, "organization_id");
        await this._createTable(tableName, [
            "id varchar(40) primary key",
            "organization_id varchar(40) not null",
            "data jsonb not null"
        ], plan.tableIndexes);
        return { tableName, createdIndexes: plan.infos };
    }
    /**
     * Verifies a plain aggregate's snapshot table against the given declarations, without touching
     * anything: what comes back is every divergence between what the declarations would create and
     * what this database actually holds.
     *
     * This is the detector for the gap `create ... if not exists` leaves open. Creation matches on
     * name alone and never reconciles, so a declaration changed *after* its migration ran - a path
     * added to the query set, a cast added to an indexed path, a cleared `unique`, a scalar turned
     * array - changes nothing in the database, while every query against it still compiles and runs.
     * The failure is a silent sequential scan behind a predicate that looks indexed. Migrations are
     * versioned and never re-run, so the drift is invisible until something reads the catalog and
     * compares - which is what this does.
     *
     * Call it where the answer can act: as the last step of a migration run (throw on any `fatal`
     * issue), or in an integration test against a real database, asserting empty the same way
     * `SnapshotQuerySet.verifyDocument` is asserted -
     * `assert.deepStrictEqual(await creator.verifySnapshotTableForAggregate(Order, OrderRepository.indexes), [])`.
     *
     * The comparison is structural, from `pg_catalog` - name, uniqueness, access method, column
     * count, and each expression column's **result type** (`pg_attribute`), which is how a cast
     * mismatch is caught exactly: an index over `((data->>'total')::numeric)` carries a `numeric`
     * attribute where the uncast index carries `text`, however Postgres chooses to print the
     * expression. What it deliberately does not answer: whether the planner *uses* an index for a
     * given predicate (only `explain` can), an index built by hand under a non-convention name, or
     * rows written before a declaration changed. Shape drift inside the documents is
     * `SnapshotQuerySet.verifyDocument`'s job.
     *
     * @param {AggregateRootClassOf<TState>} aggregateType - The aggregate class whose snapshot table is verified.
     * @param {SnapshotTableOptions<TState>} [options] - The same argument the create call takes: the repository's `SnapshotQuerySet`, or the two index collections. Omit for no indexes.
     * @returns {Promise<ReadonlyArray<SnapshotDriftIssue>>} A promise that resolves to every divergence found; empty means the database matches the declarations.
     * @throws {ArgumentNullException} If aggregateType is null or undefined, or an element of either collection is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, the derived table or index name is invalid, or the indexes are invalid or duplicated - a broken declaration throws exactly as the create call would; only *drift* is returned as issues.
     * @throws {DbException} If a catalog query fails.
     */
    async verifySnapshotTableForAggregate(aggregateType, options) {
        const tableName = this._validateTableName(DataHelper.createSnapshotTableName(aggregateType));
        const plan = this._planSnapshotTable(tableName, options);
        return this._verifySnapshotTable(tableName, plan.expected, false);
    }
    /**
     * Verifies an org-scoped aggregate's snapshot table against the given declarations - see
     * {@link verifySnapshotTableForAggregate} for what verification is and where to call it.
     *
     * Additionally checks what the org variant of creation adds: that the table carries the
     * `organization_id` column (a table created before the aggregate became org-scoped does not, and
     * `create table if not exists` never adds it), that every declared btree index leads with that
     * column, and that the standalone `(organization_id)` index exists when no btree declaration
     * covers the column.
     *
     * @param {OrgAggregateRootClassOf<TState>} aggregateType - The org-scoped aggregate class whose snapshot table is verified.
     * @param {SnapshotTableOptions<TState>} [options] - The same argument the create call takes. Omit for no indexes.
     * @returns {Promise<ReadonlyArray<SnapshotDriftIssue>>} A promise that resolves to every divergence found; empty means the database matches the declarations.
     * @throws {ArgumentNullException} If aggregateType is null or undefined, or an element of either collection is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, the derived table or index name is invalid, or the indexes are invalid or duplicated.
     * @throws {DbException} If a catalog query fails.
     */
    async verifySnapshotTableForOrgAggregate(aggregateType, options) {
        const tableName = this._validateTableName(DataHelper.createSnapshotTableName(aggregateType));
        const plan = this._planSnapshotTable(tableName, options, "organization_id");
        return this._verifySnapshotTable(tableName, plan.expected, true);
    }
    /**
     * Verifies that a plain aggregate's event-stream table exists.
     *
     * Existence is the whole check on purpose: the event-stream table's columns and its one unique
     * index are fixed by {@link createEventStreamTableForAggregate} rather than declared, and both are
     * emitted by the same call that creates the table - there is no declaration to drift from. What
     * this catches is the table whose migration never ran here, *before* the first read raises a raw
     * `relation does not exist` from Postgres.
     *
     * @param {AggregateRootClass} aggregateType - The aggregate class whose event-stream table is verified.
     * @returns {Promise<ReadonlyArray<SnapshotDriftIssue>>} A promise that resolves to the missing-table issue, or empty.
     * @throws {ArgumentNullException} If aggregateType is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, or the derived table name is invalid.
     * @throws {DbException} If a catalog query fails.
     */
    async verifyEventStreamTableForAggregate(aggregateType) {
        const tableName = this._validateTableName(DataHelper.createEventStreamTableName(aggregateType));
        return this._verifyTable(tableName, false);
    }
    /**
     * Verifies that an org-scoped aggregate's event-stream table exists and carries the
     * `organization_id` column - see {@link verifyEventStreamTableForAggregate} for why existence is
     * the whole index-level check.
     *
     * @param {OrgAggregateRootClass} aggregateType - The org-scoped aggregate class whose event-stream table is verified.
     * @returns {Promise<ReadonlyArray<SnapshotDriftIssue>>} A promise that resolves to the issues found, or empty.
     * @throws {ArgumentNullException} If aggregateType is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, or the derived table name is invalid.
     * @throws {DbException} If a catalog query fails.
     */
    async verifyEventStreamTableForOrgAggregate(aggregateType) {
        const tableName = this._validateTableName(DataHelper.createEventStreamTableName(aggregateType));
        return this._verifyTable(tableName, true);
    }
    /**
     * Detects drift on a plain aggregate's snapshot table and executes the mechanical fixes:
     * verify, run each fatal issue's {@link SnapshotDriftIssue.fix}, verify again, and report both
     * what was fixed and what remains.
     *
     * **This is the one method in this API that drops anything** - named for that consequence, the
     * way `queryAcrossOrganizations` is named for its. What keeps it safe is the boundary the issues
     * already draw: only a `fatal` issue carries a `fix`, so an advisory orphan - possibly the
     * deliberate hand-built `text_pattern_ops` index the docs recommend - is never touched, ever.
     * Each fix runs as one command, and a multi-statement command is one implicit transaction, so a
     * `drop ...; create ...` whose create fails (recreating a unique index over data that has grown
     * duplicates, say) rolls its drop back and leaves the old index standing; the `DbException`
     * propagates, fixes already executed stand, and re-running resumes, since everything is
     * detection-driven.
     *
     * Two refusals, both reported through {@link SnapshotReconcileResult.remaining} with nothing
     * executed: a missing table (the creating migration has not run here - reconciling would
     * silently stand in for migration history), and on the org variant a missing `organization_id`
     * column (the index fixes would themselves fail against it; the table needs a hand-written
     * migration first).
     *
     * Call it where migrations run. A plain `create index` blocks writes to the table for the
     * duration of the build, which is a deploy-time cost and a production-traffic incident - the
     * same reason nothing verifies or reconciles on the query path.
     *
     * @param {AggregateRootClassOf<TState>} aggregateType - The aggregate class whose snapshot table is reconciled.
     * @param {SnapshotTableOptions<TState>} [options] - The same argument the create call takes. Omit for no indexes.
     * @returns {Promise<SnapshotReconcileResult>} A promise that resolves to what was fixed and what remains.
     * @throws {ArgumentNullException} If aggregateType is null or undefined, or an element of either collection is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, the derived table or index name is invalid, or the indexes are invalid or duplicated.
     * @throws {DbException} If a catalog query or an executed fix fails.
     */
    async reconcileSnapshotTableForAggregate(aggregateType, options) {
        const tableName = this._validateTableName(DataHelper.createSnapshotTableName(aggregateType));
        const plan = this._planSnapshotTable(tableName, options);
        return this._reconcileSnapshotTable(tableName, plan.expected, false);
    }
    /**
     * Like {@link reconcileSnapshotTableForAggregate}, for an org-scoped aggregate - every caveat
     * there applies, plus the `organization_id` refusal described there.
     *
     * There are no event-stream reconcile methods on purpose: the event-stream verify only checks
     * existence, and `createEventStreamTableForAggregate` *is* its reconcile - idempotent, and with
     * nothing declaration-driven to drift.
     *
     * @param {OrgAggregateRootClassOf<TState>} aggregateType - The org-scoped aggregate class whose snapshot table is reconciled.
     * @param {SnapshotTableOptions<TState>} [options] - The same argument the create call takes. Omit for no indexes.
     * @returns {Promise<SnapshotReconcileResult>} A promise that resolves to what was fixed and what remains.
     * @throws {ArgumentNullException} If aggregateType is null or undefined, or an element of either collection is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, the derived table or index name is invalid, or the indexes are invalid or duplicated.
     * @throws {DbException} If a catalog query or an executed fix fails.
     */
    async reconcileSnapshotTableForOrgAggregate(aggregateType, options) {
        const tableName = this._validateTableName(DataHelper.createSnapshotTableName(aggregateType));
        const plan = this._planSnapshotTable(tableName, options, "organization_id");
        return this._reconcileSnapshotTable(tableName, plan.expected, true);
    }
    /**
     * Validates an index name against Postgres's constraints and returns it trimmed.
     *
     * Ensures the name is a valid unquoted identifier, carries the `idx_` prefix convention,
     * and does not exceed the Postgres identifier limit (63) - which would otherwise cause
     * the name to be silently truncated, risking collisions or a skipped index.
     *
     * @param {string} indexName - The candidate index name to validate.
     * @returns {string} The validated, trimmed index name.
     * @throws {ArgumentNullException} If the name is null or undefined.
     * @throws {ArgumentException} If the name is not a string, is empty or whitespace, is missing the `idx_` prefix, is not a valid identifier, or is too long.
     */
    validateIndexName(indexName) {
        const validated = this._validateIdentifier(indexName, "indexName");
        given(validated, "indexName")
            .ensure(t => t.startsWith(DbTableCreator._indexNamePrefix), `index name '${validated}' must start with '${DbTableCreator._indexNamePrefix}'`);
        return validated;
    }
    /**
     * Builds the conventional `idx_<tableName>` index name and validates it.
     *
     * When a `suffix` is supplied it is appended as `idx_<tableName>_<suffix>`, allowing
     * multiple distinct indexes to be named for the same table.
     *
     * @param {string} tableName - The table the index belongs to.
     * @param {string} [suffix] - Optional suffix appended to disambiguate multiple indexes on the same table.
     * @returns {string} The validated index name.
     * @throws {ArgumentNullException} If tableName is null or undefined.
     * @throws {ArgumentException} If tableName or suffix is not a string, tableName is empty or whitespace, or the resulting index name fails {@link validateIndexName}.
     */
    createIndexNameFromTableName(tableName, suffix) {
        given(tableName, "tableName").ensureHasValue().ensureIsString();
        given(suffix, "suffix").ensureIsString();
        const trimmedTableName = tableName.trim();
        const trimmedSuffix = suffix?.trim();
        const indexName = `${DbTableCreator._indexNamePrefix}${trimmedTableName}${trimmedSuffix ? `_${trimmedSuffix}` : ""}`;
        return this.validateIndexName(indexName);
    }
    /**
     * Reads the two index collections off the options, or off a query set, which satisfies the same
     * shape.
     *
     * Trivial by design, which is the change. It used to resolve three accepted shapes - a bare
     * `SnapshotIndex` array, an options object with both fields optional, or a query set - and the
     * bare array had nowhere to carry array indexes, so the shape a caller picked silently decided
     * whether their GIN indexes got created. The array form is gone and both fields are required, so
     * the only thing left to resolve is whether an argument was given at all.
     *
     * The guard is what stops a JavaScript caller passing a scalar: without it the two reads would
     * come back undefined and the table would be created with no indexes, which fails nowhere and
     * shows up later as a sequential scan. An array trips it too, and is meant to - it is the form
     * that was removed, so the error is the migration instruction.
     *
     * @param {SnapshotTableOptions<any>} [options] - The caller's options, a query set, or nothing.
     * @returns The btree and GIN declarations, in declaration order.
     * @throws {ArgumentException} If options is neither absent nor an options-shaped object.
     */
    _readOptions(options) {
        if (options == null)
            return { indexes: [], arrayIndexes: [] };
        given(options, "options").ensureIsObject()
            .ensure(t => !Array.isArray(t), "options is an array; the bare index array is no longer accepted - pass { indexes, arrayIndexes }, or the repository's SnapshotQuerySet");
        return { indexes: options.indexes, arrayIndexes: options.arrayIndexes };
    }
    /**
     * Creates a table and its indexes, all idempotently.
     *
     * @param {string} tableName - The table to create.
     * @param {ReadonlyArray<string>} columns - The column definitions, in order.
     * @param {ReadonlyArray<TableIndex>} [indexes] - The indexes to create over the table.
     * @returns {Promise<void>} A promise that resolves once the table and indexes exist.
     */
    async _createTable(tableName, columns, indexes) {
        const validatedTableName = this._validateIdentifier(tableName, "tableName");
        given(columns, "columns").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        given(indexes, "indexes").ensureIsArray();
        await this._db.executeCommand(`
            create table if not exists ${validatedTableName}
            (
                ${columns.join(",\n                ")}
            );
        `);
        for (const index of indexes ?? []) {
            await this._db.executeCommand(`
                ${DbTableCreator._createIndexDdl(validatedTableName, index)}
            `);
        }
        await this._logger.logInfo(`TABLE CREATED [${validatedTableName}]`);
    }
    /**
     * Validates a set of index declarations against each other.
     *
     * Each index validates its own paths as they are added, so what is left are the rules that need
     * the whole set: that no two are the same index under different names, and that one path does
     * not resolve to two different expressions.
     *
     * A leading-prefix relationship - `[a]` alongside `[a, b]` - is deliberately allowed. A narrower
     * index is a legitimate size and write-cost tradeoff, and a path that is *not* the leading
     * column of a composite genuinely needs its own index to be searchable alone.
     *
     * @param {ReadonlyArray<SnapshotIndex<any>>} [indexes] - The declared btree indexes.
     * @param {ReadonlyArray<SnapshotArrayIndex<any>>} [arrayIndexes] - The declared array containment indexes.
     * @throws {ArgumentNullException} If an element of indexes is null or undefined.
     * @throws {ArgumentException} If indexes is not an array, an element is not a SnapshotIndex or SnapshotArrayIndex, two indexes are duplicates, or one path resolves to conflicting expressions.
     */
    _validateIndexes(indexes, arrayIndexes) {
        given(indexes, "indexes").ensureIsArray();
        const expressionByPath = new Map();
        const conflictingPaths = new Array();
        for (const index of indexes ?? []) {
            // guards a plain object arriving from JavaScript, where the builder is unenforced
            given(index, "index").ensureHasValue().ensureIsObject().ensureIsInstanceOf(SnapshotIndex);
            index.paths.forEach((path, i) => {
                const expression = index.expressions[i];
                const existing = expressionByPath.get(path);
                // a modelling rule, not a mechanical one: one key inside `data` holds one kind of
                // value, so indexing it as text here and as numeric there means one of the two
                // declarations has the wrong idea of the state - and only one of them can be the
                // expression a predicate for that path is built from
                if (existing != null && existing !== expression)
                    conflictingPaths.push(path);
                else
                    expressionByPath.set(path, expression);
            });
        }
        given(conflictingPaths, "indexes").ensure(t => t.isEmpty, `the same path cannot be indexed with different types: ${conflictingPaths.distinct().join(", ")}`);
        // identity is the ordered path list plus uniqueness, not the name - an explicit name would
        // otherwise let the same index be declared twice and be created twice under two names
        given(indexes ?? [], "indexes").ensure(t => t.distinct(u => `${u.paths.join(",")}|${u.isUnique}`).length === t.length, "the same index cannot be declared twice");
        given(arrayIndexes, "arrayIndexes").ensureIsArray();
        for (const arrayIndex of arrayIndexes ?? [])
            // guards a plain object arriving from JavaScript, where the builder is unenforced
            given(arrayIndex, "arrayIndex").ensureHasValue().ensureIsObject().ensureIsInstanceOf(SnapshotArrayIndex);
        // identity is the path alone - there is no uniqueness axis, since GIN cannot be unique
        given(arrayIndexes ?? [], "arrayIndexes").ensure(t => t.distinct(u => u.path).length === t.length, "the same array index cannot be declared twice");
        // One key inside `data` holds one kind of value, so indexing it as a scalar here and as an
        // array there means one of the two declarations has the wrong idea of the state - the same
        // modelling error the conflicting-type rule above catches. Unreachable through the typed
        // doors, since SnapshotPath and SnapshotArrayPath are disjoint by construction, but
        // forRawPath makes it reachable.
        const crossKindPaths = (arrayIndexes ?? []).map(t => t.path).where(t => expressionByPath.has(t));
        given(crossKindPaths, "arrayIndexes").ensure(t => t.isEmpty, `a path cannot be indexed both as a scalar and as an array: ${crossKindPaths.distinct().join(", ")}`);
    }
    /**
     * Reads the declarations once and produces everything derived from them: the DDL definitions and
     * the metadata handed back to the caller.
     *
     * Both come out of this single synchronous pass, so the returned contract is provably the same
     * data the DDL was emitted from. Reading the builders again after the DDL had been awaited would
     * let a caller who mutated one in the meantime receive expressions no index covers.
     *
     * The name comes from {@link SnapshotIndex.nameSuffix} so it is stable and readable, and so two
     * declarations on one table cannot land on the same index name - which `if not exists` would
     * silently skip rather than report. A unique index takes a `_uq` suffix so the same path can
     * carry both a lookup index and a unique one.
     *
     * An array index takes a `_gin` suffix, which is load-bearing rather than descriptive: without it
     * a btree and a GIN declaration over one path derive the same name, and `if not exists` matches
     * on name alone - so whichever ran first would win and the other would be silently skipped,
     * leaving an index that answers no query the declaration was written for.
     *
     * @param {string} tableName - The table the indexes belong to.
     * @param {ReadonlyArray<SnapshotIndex<any>>} [indexes] - The declared btree indexes.
     * @param {ReadonlyArray<SnapshotArrayIndex<any>>} [arrayIndexes] - The declared array containment indexes.
     * @param {string} [leadingColumn] - Optional real column to lead each btree index with.
     * @returns {IndexPlan} The DDL definitions and the per-index metadata.
     * @throws {ArgumentException} If two declarations derive the same index name, or a name exceeds the identifier limit.
     */
    _planIndexes(tableName, indexes, arrayIndexes, leadingColumn) {
        const tableIndexes = new Array();
        const infos = new Array();
        const expected = new Array();
        for (const index of indexes ?? []) {
            const paths = [...index.paths];
            const expressions = [...index.expressions];
            const name = this.createIndexNameFromTableName(tableName, index.isUnique ? `${index.nameSuffix}_uq` : index.nameSuffix);
            const tableIndex = {
                name,
                columns: leadingColumn != null ? [leadingColumn, ...expressions] : expressions,
                isUnique: index.isUnique
            };
            tableIndexes.push(tableIndex);
            infos.push({ name, paths, expressions, isUnique: index.isUnique, leadingColumn });
            expected.push({
                name, isUnique: index.isUnique, method: "btree", leadingColumn, paths, expressions,
                casts: [...index.casts], ddl: DbTableCreator._createIndexDdl(tableName, tableIndex)
            });
        }
        for (const arrayIndex of arrayIndexes ?? []) {
            const expression = arrayIndex.expressions[0];
            const name = this.createIndexNameFromTableName(tableName, `${arrayIndex.nameSuffix}_gin`);
            const tableIndex = {
                name,
                method: "gin",
                // the opclass rides on the column rather than on its own field, so `expression` stays
                // byte-identical to what the containment fragments are built from - the same
                // single-source rule as the btree side
                columns: [`${expression} ${SnapshotArrayIndex.opclass}`]
            };
            tableIndexes.push(tableIndex);
            // no leadingColumn, even on an org table: a GIN index genuinely does not lead with
            // organization_id, and reporting one would be a claim the caller builds a predicate on
            infos.push({ name, paths: [arrayIndex.path], expressions: [expression], isUnique: false, method: "gin" });
            expected.push({
                name, isUnique: false, method: "gin", leadingColumn: undefined,
                paths: [arrayIndex.path], expressions: [expression], casts: [],
                ddl: DbTableCreator._createIndexDdl(tableName, tableIndex)
            });
        }
        // runs over the combined list, so a btree name colliding with a GIN one is caught here
        given(tableIndexes, "indexes").ensure(t => t.distinct(u => u.name).length === t.length, "indexes cannot derive the same index name twice");
        // only the btree loop prepends the leading column, so this is exact rather than approximate
        return { tableIndexes, infos, expected, hasLeadingColumnIndex: leadingColumn != null && (indexes?.isNotEmpty ?? false) };
    }
    /**
     * The whole pipeline from a set of declarations to a snapshot table's index plan: read, validate,
     * plan, and append the standalone leading-column index where the org variant needs one.
     *
     * The one place this runs is the point: `create*` emits DDL from the plan and `verify*` compares
     * the catalog against the same plan, so what creation would build and what verification expects
     * provably cannot diverge - the same single-pass argument {@link _planIndexes} makes for the DDL
     * and the returned contract, one level up.
     *
     * @param {string} tableName - The validated snapshot table name.
     * @param {SnapshotTableOptions<any>} [options] - The caller's options, a query set, or nothing.
     * @param {string} [leadingColumn] - The real column every btree index leads with, on an org-scoped table.
     * @returns {IndexPlan} The plan, with the standalone index appended when applicable.
     * @throws {ArgumentNullException} If an element of either collection is null or undefined.
     * @throws {ArgumentException} If the options or indexes are invalid, duplicated, or derive colliding names.
     */
    _planSnapshotTable(tableName, options, leadingColumn) {
        const { indexes, arrayIndexes } = this._readOptions(options);
        this._validateIndexes(indexes, arrayIndexes);
        const plan = this._planIndexes(tableName, indexes, arrayIndexes, leadingColumn);
        // appended rather than unshifted, so the emission order of the declared indexes is unmoved
        if (leadingColumn != null && !plan.hasLeadingColumnIndex) {
            const standalone = {
                name: this.createIndexNameFromTableName(tableName),
                columns: [leadingColumn]
            };
            plan.tableIndexes.push(standalone);
            plan.infos.push({ name: standalone.name, paths: [], expressions: [], isUnique: false, leadingColumn });
            plan.expected.push({
                name: standalone.name, isUnique: false, method: "btree", leadingColumn,
                paths: [], expressions: [], casts: [],
                ddl: DbTableCreator._createIndexDdl(tableName, standalone)
            });
        }
        return plan;
    }
    /**
     * Checks that a table exists, and on an org-scoped one that it carries the `organization_id`
     * column - the two table-level drifts, ahead of any index comparison.
     *
     * @param {string} tableName - The validated table name.
     * @param {boolean} orgScoped - Whether the declaration is org-scoped.
     * @returns {Promise<Array<SnapshotDriftIssue>>} The table-level issues found, or empty.
     */
    async _verifyTable(tableName, orgScoped) {
        const issues = new Array();
        const columns = await this._fetchTableColumns(tableName);
        if (columns.isEmpty) {
            issues.push({
                tableName, kind: "table-missing", severity: "fatal",
                message: `table '${tableName}' does not exist in this database - the migration that creates it has not run here, and every read of it will raise 'relation does not exist'`
            });
            return issues;
        }
        if (orgScoped && !columns.contains("organization_id"))
            issues.push({
                tableName, kind: "column-missing", severity: "fatal",
                // no `fix`: adding a not-null column to a populated table needs a default-and-backfill
                // decision (which organization owns the existing rows?) that a canned statement would
                // get wrong
                message: `table '${tableName}' has no 'organization_id' column - it predates the aggregate becoming org-scoped, and 'create table if not exists' never adds columns; add the column in a hand-written migration, with a backfill that decides which organization owns the existing rows`
            });
        return issues;
    }
    /**
     * The verification pipeline shared by the two snapshot `verify*` methods: table-level checks,
     * then the structural index comparison. A missing table short-circuits - there are no indexes to
     * compare, and every one reported missing would restate what the first issue already says.
     *
     * @param {string} tableName - The validated snapshot table name.
     * @param {ReadonlyArray<ExpectedIndex>} expected - The plan's expected indexes.
     * @param {boolean} orgScoped - Whether the declaration is org-scoped.
     * @returns {Promise<ReadonlyArray<SnapshotDriftIssue>>} Every divergence found, or empty.
     */
    async _verifySnapshotTable(tableName, expected, orgScoped) {
        const issues = await this._verifyTable(tableName, orgScoped);
        if (issues.some(t => t.kind === "table-missing"))
            return issues;
        const actual = await this._fetchTableIndexes(tableName);
        issues.push(...DbTableCreator._compareIndexes(tableName, expected, actual));
        return issues;
    }
    /**
     * The reconcile pipeline shared by the two snapshot `reconcile*` methods: verify, execute every
     * fix the issues carry, verify again. Detection-driven end to end, which is what makes it
     * resumable - a failed or interrupted run left real state behind, and the next run's opening
     * verify finds exactly what is still wrong.
     *
     * @param {string} tableName - The validated snapshot table name.
     * @param {ReadonlyArray<ExpectedIndex>} expected - The plan's expected indexes.
     * @param {boolean} orgScoped - Whether the declaration is org-scoped.
     * @returns {Promise<SnapshotReconcileResult>} What was fixed, and what the closing verify still reports.
     */
    async _reconcileSnapshotTable(tableName, expected, orgScoped) {
        const issues = await this._verifySnapshotTable(tableName, expected, orgScoped);
        // a table-level fatal gates everything: a missing table means the creating migration has
        // not run here, and reconciling past that would silently stand in for migration history;
        // a missing organization_id column would make every org index fix fail against it
        if (issues.some(t => t.kind === "table-missing" || t.kind === "column-missing"))
            return { tableName, fixed: [], remaining: issues };
        const fixed = new Array();
        for (const issue of issues) {
            // only fatal issues carry a fix; an advisory - possibly a deliberate hand-built index -
            // is never touched
            if (issue.fix == null)
                continue;
            // one command per fix: a multi-statement command travels as one implicit transaction,
            // so a drop-and-recreate whose create fails rolls its drop back and the old index
            // stands; the DbException propagates, and fixes already executed stand too
            await this._db.executeCommand(issue.fix);
            await this._logger.logInfo(`INDEX RECONCILED [${issue.indexName}] via: ${issue.fix}`);
            fixed.push(issue);
        }
        const remaining = await this._verifySnapshotTable(tableName, expected, orgScoped);
        return { tableName, fixed, remaining };
    }
    /**
     * Reads a table's column names from `information_schema`. Empty means the table does not exist.
     *
     * @param {string} tableName - The validated table name.
     * @returns {Promise<ReadonlyArray<string>>} The column names, in ordinal order.
     */
    async _fetchTableColumns(tableName) {
        const result = await this._db.executeQuery(`
            select column_name as "columnName"
            from information_schema.columns
            where table_schema = current_schema() and table_name = ?
            order by ordinal_position;
        `, tableName);
        return result.rows.map(t => t.columnName);
    }
    /**
     * Reads every index on a table from `pg_catalog`, structurally rather than as definition text.
     *
     * Per index: name, uniqueness, access method, column count, and per column the **result type**
     * (`format_type` over `pg_attribute` - for an expression column that is the expression's type,
     * which is what makes a cast comparable exactly, independent of how Postgres prints the
     * expression) and the pretty-printed column definition (`pg_get_indexdef` with a column number -
     * used only for token containment, never equality, because Postgres normalizes expression text:
     * `(data->>'status')` comes back as `((data ->> 'status'::text))` and a quoted path array loses
     * its quotes).
     *
     * @param {string} tableName - The validated table name.
     * @returns {Promise<ReadonlyArray<ActualTableIndex>>} Every index on the table.
     */
    async _fetchTableIndexes(tableName) {
        const result = await this._db.executeQuery(`
            select
                ic.relname as "indexName",
                ix.indisunique as "isUnique",
                am.amname as "method",
                ix.indnatts::int as "columnCount",
                (select array_agg(format_type(a.atttypid, a.atttypmod) order by a.attnum)
                   from pg_attribute a where a.attrelid = ix.indexrelid) as "columnTypes",
                (select array_agg(pg_get_indexdef(ix.indexrelid, s.n, true) order by s.n)
                   from generate_series(1, ix.indnatts::int) as s(n)) as "columnDefs",
                pg_get_indexdef(ix.indexrelid) as "indexDef"
            from pg_index ix
            join pg_class ic on ic.oid = ix.indexrelid
            join pg_class tc on tc.oid = ix.indrelid
            join pg_namespace ns on ns.oid = tc.relnamespace
            join pg_am am on am.oid = ic.relam
            where tc.relname = ? and ns.nspname = current_schema();
        `, tableName);
        return result.rows;
    }
    /**
     * Validates a Postgres identifier and returns it trimmed.
     *
     * @param {string} value - The candidate identifier.
     * @param {string} argName - The argument name to report in errors.
     * @param {number} [maxLength] - The budget to enforce; defaults to the full Postgres limit.
     * @returns {string} The validated, trimmed identifier.
     * @throws {ArgumentNullException} If the value is null or undefined.
     * @throws {ArgumentException} If the value is not a string, is empty or whitespace, is not a valid identifier, or is too long.
     */
    _validateIdentifier(value, argName, maxLength = DbTableCreator._maxIdentifierLength) {
        given(value, argName).ensureHasValue().ensureIsString();
        const trimmed = value.trim();
        given(trimmed, argName)
            .ensure(t => DbTableCreator._identifierRegex.test(t), `${argName} '${trimmed}' must contain only lowercase letters, digits and underscores, and cannot start with a digit`)
            .ensure(t => t.length <= maxLength, `${argName} '${trimmed}' (${trimmed.length} chars) exceeds the max length of ${maxLength} and would be silently truncated`);
        return trimmed;
    }
    /**
     * Validates a derived table name, budgeting for the index names composed over it.
     *
     * Every index this class creates is named `idx_<tableName>[_<suffix>]`, so a table name that
     * uses the full 63 characters leaves no room for one. Validating against the reduced budget here
     * means an overlong aggregate name is reported against `tableName` - the identifier actually at
     * fault - rather than against a derived `indexName` further downstream.
     *
     * @param {string} tableName - The derived table name.
     * @returns {string} The validated, trimmed table name.
     * @throws {ArgumentNullException} If tableName is null or undefined.
     * @throws {ArgumentException} If tableName is not a string, is empty or whitespace, is not a valid identifier, or leaves no room for an index name.
     */
    _validateTableName(tableName) {
        return this._validateIdentifier(tableName, "tableName", DbTableCreator._maxIdentifierLength - DbTableCreator._indexNamePrefix.length);
    }
}
//# sourceMappingURL=db-table-creator.js.map