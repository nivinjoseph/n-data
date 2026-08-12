import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "../repository/data-helper.js";
import { SnapshotArrayIndex } from "./snapshot-array-index.js";
import { SnapshotIndex } from "./snapshot-index.js";
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
        const { indexes, arrayIndexes } = this._readOptions(options);
        this._validateIndexes(indexes, arrayIndexes);
        const plan = this._planIndexes(tableName, indexes, arrayIndexes);
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
        const { indexes, arrayIndexes } = this._readOptions(options);
        this._validateIndexes(indexes, arrayIndexes);
        const plan = this._planIndexes(tableName, indexes, arrayIndexes, "organization_id");
        // appended rather than unshifted, so the emission order of the declared indexes is unmoved
        if (!plan.hasLeadingColumnIndex)
            plan.tableIndexes.push({
                name: this.createIndexNameFromTableName(tableName),
                columns: ["organization_id"]
            });
        await this._createTable(tableName, [
            "id varchar(40) primary key",
            "organization_id varchar(40) not null",
            "data jsonb not null"
        ], plan.tableIndexes);
        return { tableName, createdIndexes: plan.infos };
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
                create ${index.isUnique === true ? "unique " : ""}index if not exists ${index.name} on ${validatedTableName}${index.method != null ? ` using ${index.method}` : ""}(${index.columns.join(", ")});
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
        for (const index of indexes ?? []) {
            const paths = [...index.paths];
            const expressions = [...index.expressions];
            const name = this.createIndexNameFromTableName(tableName, index.isUnique ? `${index.nameSuffix}_uq` : index.nameSuffix);
            tableIndexes.push({
                name,
                columns: leadingColumn != null ? [leadingColumn, ...expressions] : expressions,
                isUnique: index.isUnique
            });
            infos.push({ name, paths, expressions, isUnique: index.isUnique, leadingColumn });
        }
        for (const arrayIndex of arrayIndexes ?? []) {
            const expression = arrayIndex.expressions[0];
            const name = this.createIndexNameFromTableName(tableName, `${arrayIndex.nameSuffix}_gin`);
            tableIndexes.push({
                name,
                method: "gin",
                // the opclass rides on the column rather than on its own field, so `expression` stays
                // byte-identical to what the containment fragments are built from - the same
                // single-source rule as the btree side
                columns: [`${expression} ${SnapshotArrayIndex.opclass}`]
            });
            // no leadingColumn, even on an org table: a GIN index genuinely does not lead with
            // organization_id, and reporting one would be a claim the caller builds a predicate on
            infos.push({ name, paths: [arrayIndex.path], expressions: [expression], isUnique: false, method: "gin" });
        }
        // runs over the combined list, so a btree name colliding with a GIN one is caught here
        given(tableIndexes, "indexes").ensure(t => t.distinct(u => u.name).length === t.length, "indexes cannot derive the same index name twice");
        // only the btree loop prepends the leading column, so this is exact rather than approximate
        return { tableIndexes, infos, hasLeadingColumnIndex: leadingColumn != null && (indexes?.isNotEmpty ?? false) };
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