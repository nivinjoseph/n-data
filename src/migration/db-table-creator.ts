import { given } from "@nivinjoseph/n-defensive";
import { AggregateState, OrgAggregateState } from "@nivinjoseph/n-domain";
import { Db } from "../db/db.js";
import { Logger } from "@nivinjoseph/n-log";
import { AggregateRootClass, AggregateRootClassOf, DataHelper, OrgAggregateRootClass, OrgAggregateRootClassOf } from "../repository/data-helper.js";
import { SnapshotArrayIndex } from "./snapshot-array-index.js";
import { SnapshotIndex } from "./snapshot-index.js";

/**
 * One index that was created over a snapshot table.
 */
export interface SnapshotTableIndexInfo
{
    /**
     * The index's name as created.
     */
    readonly name: string;

    /**
     * The paths it covers, trimmed, in column order.
     */
    readonly paths: ReadonlyArray<string>;

    /**
     * The extraction expressions, positionally matching {@link paths}.
     */
    readonly expressions: ReadonlyArray<string>;

    /**
     * Whether the index enforces uniqueness. Always false for a `gin` index - Postgres rejects
     * `create unique index ... using gin` outright.
     */
    readonly isUnique: boolean;

    /**
     * The access method the index was created with: `"gin"` for an array-containment index,
     * `undefined` for the default btree.
     *
     * It decides what a predicate may be. A btree index serves `=`, ranges and `order by` over
     * {@link expressions}; a GIN index serves `@>` containment and nothing else, and only through the
     * fragments `SnapshotArrayIndex.containmentForPath` produces.
     */
    readonly method?: "gin";

    /**
     * A real column the index leads with ahead of {@link expressions} - `organization_id` on an
     * org-scoped table, `undefined` otherwise. A predicate must constrain this too before any of the
     * expressions can be used; conversely, constraining it alone is a valid leading prefix and does
     * use the index.
     *
     * `undefined` for a `gin` index **including on an org-scoped table**, which genuinely does not
     * lead with `organization_id`: a multicolumn GIN over a varchar column would need the `btree_gin`
     * extension, which is not trusted on Postgres 12 and would demand superuser at migration time. An
     * org-scoped table declaring one therefore always carries a standalone `(organization_id)` btree
     * index for the planner to BitmapAnd the GIN scan against. `organization_id` is constrained
     * regardless - `OrgSnapshotBaseRepository.query` adds it either way, because tenant isolation is a
     * correctness rule independent of the plan.
     */
    readonly leadingColumn?: string;
}

/**
 * What to create over a snapshot table's `data` column, beyond the table itself.
 *
 * Two collections rather than one, because the two kinds are not interchangeable: a
 * {@link SnapshotIndex} is a btree over extracted text and answers `=`, ranges and `order by`; a
 * {@link SnapshotArrayIndex} is a GIN over an extracted jsonb array and answers containment and
 * nothing else. Keeping them apart is what lets each carry its own rules as a shape rather than as a
 * runtime check - a GIN index cannot be unique, cannot compose, and cannot lead with a real column.
 */
export interface SnapshotTableOptions<TState>
{
    /**
     * Btree expression indexes over leaf scalars inside `data`.
     *
     * **Required, and empty rather than absent when there are none.** Both collections are, and that
     * is the point of them: a caller who has btree indexes and no array ones has to say so. Passing
     * `{ indexes: querySet.indexes }` used to compile and create every btree index while silently
     * omitting every GIN one, after which `contains` sequential-scanned forever with nothing failing
     * at migration time. Omitting the whole options argument is still how "no indexes at all" is said.
     */
    readonly indexes: ReadonlyArray<SnapshotIndex<TState>>;

    /**
     * GIN containment indexes over arrays inside `data`. Required; see {@link indexes}.
     */
    readonly arrayIndexes: ReadonlyArray<SnapshotArrayIndex<TState>>;
}

/**
 * The result of creating a snapshot table.
 */
export interface SnapshotTableInfo
{
    /**
     * The created table's name.
     */
    readonly tableName: string;

    /**
     * The indexes as created, in declaration order, with their grouping and column order intact.
     *
     * **Named for what it holds, which is not what was declared.** It includes what the creator added
     * on its own - the standalone `(organization_id)` index on an org-scoped table - and it reports a
     * GIN index's real shape rather than the declaration's. Three other things in this library are
     * called `indexes` (`SnapshotQuerySet.indexes` and `SnapshotTableOptions.indexes`, both btree
     * declarations only, and the `static readonly indexes` a repository conventionally names its query
     * set), and this was the one that meant something different.
     *
     * Predicates are not built from here - they come from the declarations, via
     * {@link SnapshotIndex.expressionForPath}, whose expression provably matches what was indexed.
     * Read this to see what a predicate has to constrain, since a btree index only serves a leading
     * prefix of its columns - so the second path of a composite, or anything on an org-scoped table
     * ahead of `organization_id`, is not independently searchable.
     */
    readonly createdIndexes: ReadonlyArray<SnapshotTableIndexInfo>;
}

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
export class DbTableCreator
{
    /**
     * Maximum identifier length Postgres permits before silently truncating.
     * Postgres truncates identifiers to NAMEDATALEN - 1 = 63 bytes.
     */
    private static readonly _maxIdentifierLength = 63;

    /**
     * An unquoted Postgres identifier that needs no folding: lowercase, digits, underscores.
     * Anything else would either be truncated, folded, or change the statement's meaning
     * once interpolated into DDL.
     */
    private static readonly _identifierRegex = /^[a-z_][a-z0-9_]*$/;

    /**
     * The prefix every index name carries. Its length is the budget a derived table name must leave
     * free, so an index name composed over it can still fit.
     */
    private static readonly _indexNamePrefix = "idx_";

    private readonly _db: Db;
    private readonly _logger: Logger;

    /**
     * Creates a new DbTableCreator.
     *
     * @param {Db} db - The writable database used to execute the DDL commands.
     * @param {Logger} logger - The logger used to record each table creation.
     */
    public constructor(db: Db, logger: Logger)
    {
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
    public async createEventStreamTableForAggregate(aggregateType: AggregateRootClass): Promise<string>
    {
        const tableName = this._validateTableName(DataHelper.createEventStreamTableName(aggregateType));

        await this._createTable(
            tableName,
            [
                "id varchar(50) primary key",
                "aggregate_id varchar(40) not null",
                "aggregate_version integer not null",
                "data jsonb not null"
            ],
            [{
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
    public async createEventStreamTableForOrgAggregate(aggregateType: OrgAggregateRootClass): Promise<string>
    {
        const tableName = this._validateTableName(DataHelper.createEventStreamTableName(aggregateType));

        await this._createTable(
            tableName,
            [
                "id varchar(50) primary key",
                "aggregate_id varchar(40) not null",
                "aggregate_version integer not null",
                "organization_id varchar(40) not null",
                "data jsonb not null"
            ],
            [{
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
    public async createSnapshotTableForAggregate<TState extends AggregateState>(
        aggregateType: AggregateRootClassOf<TState>,
        options?: SnapshotTableOptions<TState>): Promise<SnapshotTableInfo>
    {
        const tableName = this._validateTableName(DataHelper.createSnapshotTableName(aggregateType as AggregateRootClass));

        const { indexes, arrayIndexes } = this._readOptions(options);

        this._validateIndexes(indexes, arrayIndexes);

        const plan = this._planIndexes(tableName, indexes, arrayIndexes);

        await this._createTable(
            tableName,
            [
                "id varchar(40) primary key",
                "data jsonb not null"
            ],
            plan.tableIndexes);

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
    public async createSnapshotTableForOrgAggregate<TState extends OrgAggregateState>(
        aggregateType: OrgAggregateRootClassOf<TState>,
        options?: SnapshotTableOptions<TState>): Promise<SnapshotTableInfo>
    {
        const tableName = this._validateTableName(DataHelper.createSnapshotTableName(aggregateType as OrgAggregateRootClass));

        const { indexes, arrayIndexes } = this._readOptions(options);

        this._validateIndexes(indexes, arrayIndexes);

        const plan = this._planIndexes(tableName, indexes, arrayIndexes, "organization_id");

        // appended rather than unshifted, so the emission order of the declared indexes is unmoved
        if (!plan.hasLeadingColumnIndex)
            plan.tableIndexes.push({
                name: this.createIndexNameFromTableName(tableName),
                columns: ["organization_id"]
            });

        await this._createTable(
            tableName,
            [
                "id varchar(40) primary key",
                "organization_id varchar(40) not null",
                "data jsonb not null"
            ],
            plan.tableIndexes);

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
    public validateIndexName(indexName: string): string
    {
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
    public createIndexNameFromTableName(tableName: string, suffix?: string): string
    {
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
    private _readOptions(options?: SnapshotTableOptions<any>): {
        indexes: ReadonlyArray<SnapshotIndex<any>>;
        arrayIndexes: ReadonlyArray<SnapshotArrayIndex<any>>;
    }
    {
        if (options == null)
            return { indexes: [], arrayIndexes: [] };

        given(options, "options").ensureIsObject()
            .ensure(t => !Array.isArray(t),
                "options is an array; the bare index array is no longer accepted - pass { indexes, arrayIndexes }, or the repository's SnapshotQuerySet");

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
    private async _createTable(tableName: string, columns: ReadonlyArray<string>, indexes?: ReadonlyArray<TableIndex>): Promise<void>
    {
        const validatedTableName = this._validateIdentifier(tableName, "tableName");

        given(columns, "columns").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        given(indexes, "indexes").ensureIsArray();

        await this._db.executeCommand(`
            create table if not exists ${validatedTableName}
            (
                ${columns.join(",\n                ")}
            );
        `);

        for (const index of indexes ?? [])
        {
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
    private _validateIndexes(indexes?: ReadonlyArray<SnapshotIndex<any>>, arrayIndexes?: ReadonlyArray<SnapshotArrayIndex<any>>): void
    {
        given(indexes, "indexes").ensureIsArray();

        const expressionByPath = new Map<string, string>();
        const conflictingPaths = new Array<string>();

        for (const index of indexes ?? [])
        {
            // guards a plain object arriving from JavaScript, where the builder is unenforced
            given(index, "index").ensureHasValue().ensureIsObject().ensureIsInstanceOf(SnapshotIndex);

            index.paths.forEach((path, i) =>
            {
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

        given(conflictingPaths, "indexes").ensure(
            t => t.isEmpty,
            `the same path cannot be indexed with different types: ${conflictingPaths.distinct().join(", ")}`
        );

        // identity is the ordered path list plus uniqueness, not the name - an explicit name would
        // otherwise let the same index be declared twice and be created twice under two names
        given(indexes ?? [], "indexes").ensure(
            t => t.distinct(u => `${u.paths.join(",")}|${u.isUnique}`).length === t.length,
            "the same index cannot be declared twice"
        );

        given(arrayIndexes, "arrayIndexes").ensureIsArray();

        for (const arrayIndex of arrayIndexes ?? [])
            // guards a plain object arriving from JavaScript, where the builder is unenforced
            given(arrayIndex, "arrayIndex").ensureHasValue().ensureIsObject().ensureIsInstanceOf(SnapshotArrayIndex);

        // identity is the path alone - there is no uniqueness axis, since GIN cannot be unique
        given(arrayIndexes ?? [], "arrayIndexes").ensure(
            t => t.distinct(u => u.path).length === t.length,
            "the same array index cannot be declared twice"
        );

        // One key inside `data` holds one kind of value, so indexing it as a scalar here and as an
        // array there means one of the two declarations has the wrong idea of the state - the same
        // modelling error the conflicting-type rule above catches. Unreachable through the typed
        // doors, since SnapshotPath and SnapshotArrayPath are disjoint by construction, but
        // forRawPath makes it reachable.
        const crossKindPaths = (arrayIndexes ?? []).map(t => t.path).where(t => expressionByPath.has(t));

        given(crossKindPaths, "arrayIndexes").ensure(
            t => t.isEmpty,
            `a path cannot be indexed both as a scalar and as an array: ${crossKindPaths.distinct().join(", ")}`
        );
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
    private _planIndexes(tableName: string, indexes?: ReadonlyArray<SnapshotIndex<any>>, arrayIndexes?: ReadonlyArray<SnapshotArrayIndex<any>>, leadingColumn?: string): IndexPlan
    {
        const tableIndexes = new Array<TableIndex>();
        const infos = new Array<SnapshotTableIndexInfo>();

        for (const index of indexes ?? [])
        {
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

        for (const arrayIndex of arrayIndexes ?? [])
        {
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
        given(tableIndexes, "indexes").ensure(
            t => t.distinct(u => u.name).length === t.length,
            "indexes cannot derive the same index name twice"
        );

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
    private _validateIdentifier(value: string, argName: string, maxLength = DbTableCreator._maxIdentifierLength): string
    {
        given(value, argName).ensureHasValue().ensureIsString();

        const trimmed = value.trim();

        given(trimmed, argName)
            .ensure(
                t => DbTableCreator._identifierRegex.test(t),
                `${argName} '${trimmed}' must contain only lowercase letters, digits and underscores, and cannot start with a digit`
            )
            .ensure(
                t => t.length <= maxLength,
                `${argName} '${trimmed}' (${trimmed.length} chars) exceeds the max length of ${maxLength} and would be silently truncated`
            )
            ;

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
    private _validateTableName(tableName: string): string
    {
        return this._validateIdentifier(
            tableName, "tableName", DbTableCreator._maxIdentifierLength - DbTableCreator._indexNamePrefix.length);
    }
}

/**
 * Everything derived from a set of index declarations in one pass: what to emit, and what to hand
 * back. Kept together so the two can never be read from the builders at different instants.
 */
interface IndexPlan
{
    /**
     * The definitions to emit as DDL. Mutable so the org variant can append its standalone
     * `(organization_id)` index when no expression indexes were declared.
     */
    readonly tableIndexes: Array<TableIndex>;

    /**
     * The per-index metadata returned as {@link SnapshotTableInfo.indexes}.
     */
    readonly infos: Array<SnapshotTableIndexInfo>;

    /**
     * Whether any planned index leads with the leading column.
     *
     * Only btree indexes do - a GIN index cannot, so a table whose only declarations are array ones
     * still needs the standalone index over that column.
     */
    readonly hasLeadingColumnIndex: boolean;
}

/**
 * An index to create over a table.
 */
interface TableIndex
{
    /**
     * The index's name.
     */
    readonly name: string;

    /**
     * The indexed columns or expressions, in order.
     */
    readonly columns: ReadonlyArray<string>;

    /**
     * Whether the index enforces uniqueness. Defaults to false.
     */
    readonly isUnique?: boolean;

    /**
     * The access method, placed as `using <method>`. Omitted for the default btree.
     *
     * A closed literal union rather than a string: it is interpolated into DDL, and every other
     * identifier this class emits is validated. A union costs nothing and is checked at compile time.
     */
    readonly method?: "gin";
}
