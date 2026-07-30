import { given } from "@nivinjoseph/n-defensive";
import { Db } from "../db/db.js";
import { Logger } from "@nivinjoseph/n-log";
import { AggregateRootClass, DataHelper, JsonValueType, OrgAggregateRootClass } from "../repository/data-helper.js";

/**
 * A key inside a snapshot table's `data` column to build an expression index over.
 *
 * No column is added to the table for this; the index is built directly over the extraction
 * expression. That keeps it retrievable on tables that already exist (an index is created
 * independently of the table, whereas adding a column would need an alter that
 * `create table if not exists` never issues) and keeps the row narrow.
 */
export interface SnapshotIndexedPath
{
    /**
     * The key within `data`; dot delimited to reach a nested key, e.g. `"customer.city"`.
     */
    readonly path: string;

    /**
     * Optional type to cast the extracted text to. Supply it whenever the value is not a
     * string: an uncast comparison orders lexicographically, making '9' > '100' true.
     *
     * Leave it off for strings. Extraction already yields text, so {@link JsonValueType.text}
     * only adds a no-op cast and a second, textually different expression for the same value.
     *
     * **Changing this on a path that already has an index does nothing to that index.** The
     * index name encodes the path but not the type, and creation is `if not exists`, which
     * matches on name alone - so adding or changing a type against an already-provisioned
     * database silently keeps the index over the *old* expression. Predicates built from the
     * returned {@link SnapshotTableInfo.indexedExpressions} then use the new expression, match
     * nothing, and sequentially scan while appearing to be indexed. Drop the index by hand to
     * have it rebuilt. Note this differs from {@link isUnique}, whose distinct name means
     * flipping it does take effect.
     */
    readonly type?: JsonValueType;

    /**
     * Enforces uniqueness over the extracted value - a natural key held inside the snapshot
     * state, such as an email, slug or invoice number.
     *
     * On an org-scoped table the index leads with `organization_id`, so uniqueness is scoped
     * to the organization rather than global. On a plain table it is global.
     *
     * Aggregates whose `data` omits the key are unconstrained: the extraction yields null,
     * and Postgres permits any number of nulls in a unique index.
     *
     * A violation surfaces from `save` as a DbException rather than a domain error. The
     * repositories upsert with `on conflict (id)`, and Postgres only routes conflicts on the
     * named arbiter index, so a collision here raises instead of being handled - which rolls
     * the unit of work back.
     *
     * The index is named `idx_<table>_<path>_uq`, deliberately distinct from the non-unique
     * `idx_<table>_<path>`. Do not "tidy" the two into one name: index creation is
     * `if not exists`, which matches on name alone, so a shared name would make turning this
     * flag on for an already-provisioned table silently keep the non-unique index - leaving the
     * constraint absent while appearing to be declared.
     *
     * That distinct name protects turning uniqueness *on*. It does not protect turning it back
     * off: clearing the flag emits the non-unique index and never drops the `_uq` one, so the
     * constraint stays enforced. Drop `idx_<table>_<path>_uq` by hand to relax it - nothing
     * here drops indexes.
     *
     * Name encoding is not comprehensive: it covers the path and this flag, but not
     * {@link type}. See that field for the consequence.
     */
    readonly isUnique?: boolean;
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
     * The indexed expressions, keyed by the `path` they were built from, trimmed. Build where
     * clauses from these so they match the indexed expressions - Postgres only uses an
     * expression index when the query expression matches, so divergence silently costs a seq
     * scan.
     */
    readonly indexedExpressions: Readonly<Record<string, string>>;
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
 * to invoke on every startup/migration run.
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
     * @throws {InvalidArgumentException} If the derived table or index name is not a valid Postgres identifier, or exceeds the identifier limit.
     * @throws {DbException} If a DDL command fails.
     */
    public async createEventStreamTableForAggregate(aggregateType: AggregateRootClass): Promise<string>
    {
        const tableName = this._validateIdentifier(DataHelper.createEventStreamTableName(aggregateType), "tableName");

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
     * @throws {InvalidArgumentException} If the derived table or index name is not a valid Postgres identifier, or exceeds the identifier limit.
     * @throws {DbException} If a DDL command fails.
     */
    public async createEventStreamTableForOrgAggregate(aggregateType: OrgAggregateRootClass): Promise<string>
    {
        const tableName = this._validateIdentifier(DataHelper.createEventStreamTableName(aggregateType), "tableName");

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
     * Each entry in `indexedPaths` produces an expression index over that key inside `data`;
     * no column is added. Build where clauses from the returned `indexedExpressions` so they
     * match what was indexed.
     *
     * @param {AggregateRootClass} aggregateType - The aggregate class whose snapshot table is created.
     * @param {ReadonlyArray<SnapshotIndexedPath>} [indexedPaths] - Optional keys within `data` to build expression indexes over.
     * @returns {Promise<SnapshotTableInfo>} A promise that resolves to the table's name and its indexed expressions.
     * @throws {InvalidArgumentException} If the derived table or index name is invalid, or a path or type is malformed, or paths collide.
     * @throws {DbException} If a DDL command fails.
     */
    public async createSnapshotTableForAggregate(aggregateType: AggregateRootClass, indexedPaths?: ReadonlyArray<SnapshotIndexedPath>): Promise<SnapshotTableInfo>
    {
        const tableName = this._validateIdentifier(DataHelper.createSnapshotTableName(aggregateType), "tableName");
        const resolvedPaths = this._resolveIndexedPaths(indexedPaths);
        const indexedExpressions = this._createIndexedExpressions(resolvedPaths);

        await this._createTable(
            tableName,
            [
                "id varchar(40) primary key",
                "data jsonb not null"
            ],
            this._createExpressionIndexes(tableName, resolvedPaths));

        return { tableName, indexedExpressions };
    }

    /**
     * Creates the snapshot table and its index for an organization-scoped aggregate.
     *
     * Like {@link createSnapshotTableForAggregate} but adds a non-null `organization_id`
     * column, and every index leads with it since
     * {@link OrgSnapshotBaseRepository} always filters on it first.
     *
     * When no `indexedPaths` are given, an index over `(organization_id)` is created to
     * support org-scoped scans. When there are, each of their indexes already leads with
     * `organization_id`, making a standalone one a strict subset of an index being built
     * anyway - so it is skipped.
     *
     * @param {OrgAggregateRootClass} aggregateType - The org-scoped aggregate class whose snapshot table is created.
     * @param {ReadonlyArray<SnapshotIndexedPath>} [indexedPaths] - Optional keys within `data` to build expression indexes over.
     * @returns {Promise<SnapshotTableInfo>} A promise that resolves to the table's name and its indexed expressions.
     * @throws {InvalidArgumentException} If the derived table or index name is invalid, or a path or type is malformed, or paths collide.
     * @throws {DbException} If a DDL command fails.
     */
    public async createSnapshotTableForOrgAggregate(aggregateType: OrgAggregateRootClass, indexedPaths?: ReadonlyArray<SnapshotIndexedPath>): Promise<SnapshotTableInfo>
    {
        const tableName = this._validateIdentifier(DataHelper.createSnapshotTableName(aggregateType), "tableName");
        const resolvedPaths = this._resolveIndexedPaths(indexedPaths);
        const indexedExpressions = this._createIndexedExpressions(resolvedPaths);

        const indexes = this._createExpressionIndexes(tableName, resolvedPaths, "organization_id");
        if (indexes.isEmpty)
            indexes.push({
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
            indexes);

        return { tableName, indexedExpressions };
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
     * @throws {ArgumentException} If the name is not a string, or is empty or whitespace.
     * @throws {InvalidArgumentException} If the name is missing the `idx_` prefix, is not a valid identifier, or is too long.
     */
    public validateIndexName(indexName: string): string
    {
        const validated = this._validateIdentifier(indexName, "indexName");

        given(validated, "indexName")
            .ensure(t => t.startsWith("idx_"), `index name '${validated}' must start with 'idx_'`);

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
     * @throws {ArgumentException} If tableName or suffix is not a string, or tableName is empty or whitespace.
     * @throws {InvalidArgumentException} If the resulting index name fails {@link validateIndexName}.
     */
    public createIndexNameFromTableName(tableName: string, suffix?: string): string
    {
        given(tableName, "tableName").ensureHasValue().ensureIsString();
        given(suffix, "suffix").ensureIsString();

        const trimmedTableName = tableName.trim();
        const trimmedSuffix = suffix?.trim();
        const indexName = `idx_${trimmedTableName}${trimmedSuffix ? `_${trimmedSuffix}` : ""}`;

        return this.validateIndexName(indexName);
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
                create ${index.isUnique === true ? "unique " : ""}index if not exists ${index.name} on ${validatedTableName}(${index.columns.join(", ")});
            `);
        }

        await this._logger.logInfo(`TABLE CREATED [${validatedTableName}]`);
    }

    /**
     * Resolves each indexed path to the expression that extracts it.
     *
     * @param {ReadonlyArray<SnapshotIndexedPath>} [indexedPaths] - The paths to resolve.
     * @returns {Array<ResolvedIndexedPath>} The resolved paths, in order; empty when there are none.
     * @throws {InvalidArgumentException} If a path or type is malformed, or two paths are the same.
     */
    private _resolveIndexedPaths(indexedPaths?: ReadonlyArray<SnapshotIndexedPath>): Array<ResolvedIndexedPath>
    {
        given(indexedPaths, "indexedPaths").ensureIsArray()
            .ensure(
                t => t.distinct(u => u.path.trim()).length === t.length,
                "indexedPaths cannot contain the same path twice"
            );

        const resolved = new Array<ResolvedIndexedPath>();

        for (const indexedPath of indexedPaths ?? [])
        {
            given(indexedPath, "indexedPath").ensureHasValue().ensureIsObject();

            resolved.push({
                // trimmed, so the key callers look expressions up by is the key actually extracted
                path: indexedPath.path.trim(),
                expression: DataHelper.createJsonPathExpression(indexedPath.path, indexedPath.type),
                isUnique: indexedPath.isUnique === true
            });
        }

        return resolved;
    }

    /**
     * Builds the expressions keyed by the path they came from, for callers to build predicates with.
     *
     * @param {ReadonlyArray<ResolvedIndexedPath>} resolved - The resolved paths.
     * @returns {Record<string, string>} The expressions, keyed by path; empty when there are none.
     */
    private _createIndexedExpressions(resolved: ReadonlyArray<ResolvedIndexedPath>): Record<string, string>
    {
        const expressions: Record<string, string> = {};

        for (const t of resolved)
            expressions[t.path] = t.expression;

        return expressions;
    }

    /**
     * Turns resolved paths into index definitions, one per path.
     *
     * The index name is derived from the path so it is stable and readable, and so two paths
     * on one table cannot land on the same index name - which `if not exists` would silently
     * skip rather than report. A unique index takes a `_uq` suffix so it can never share a
     * name with a non-unique index over the same path; see {@link SnapshotIndexedPath.isUnique}.
     *
     * @param {string} tableName - The table the indexes belong to.
     * @param {ReadonlyArray<ResolvedIndexedPath>} resolved - The resolved paths to index.
     * @param {string} [leadingColumn] - Optional column to lead each index with.
     * @returns {Array<TableIndex>} The index definitions; empty when there are no paths.
     * @throws {InvalidArgumentException} If two paths derive the same index name.
     */
    private _createExpressionIndexes(tableName: string, resolved: ReadonlyArray<ResolvedIndexedPath>, leadingColumn?: string): Array<TableIndex>
    {
        const indexes = new Array<TableIndex>();

        for (const { path, expression, isUnique } of resolved)
        {
            // a path is a bare JSON key sequence, so lowercasing and swapping '.' for '_'
            // always yields a valid identifier - except where the key is already snake_cased
            // in a way that collides with a nested path, which the distinct check below catches
            const base = path.trim().toLowerCase().replaceAll(".", "_");

            indexes.push({
                name: this.createIndexNameFromTableName(tableName, isUnique ? `${base}_uq` : base),
                columns: leadingColumn != null ? [leadingColumn, expression] : [expression],
                isUnique
            });
        }

        given(indexes, "indexes").ensure(
            t => t.distinct(u => u.name).length === t.length,
            "indexedPaths cannot derive the same index name twice"
        );

        return indexes;
    }

    /**
     * Validates a Postgres identifier and returns it trimmed.
     *
     * @param {string} value - The candidate identifier.
     * @param {string} argName - The argument name to report in errors.
     * @returns {string} The validated, trimmed identifier.
     * @throws {ArgumentNullException} If the value is null or undefined.
     * @throws {ArgumentException} If the value is not a string, or is empty or whitespace.
     * @throws {InvalidArgumentException} If the value is not a valid identifier, or is too long.
     */
    private _validateIdentifier(value: string, argName: string): string
    {
        given(value, argName).ensureHasValue().ensureIsString();

        const trimmed = value.trim();

        given(trimmed, argName)
            .ensure(
                t => DbTableCreator._identifierRegex.test(t),
                `${argName} '${trimmed}' must contain only lowercase letters, digits and underscores, and cannot start with a digit`
            )
            .ensure(
                t => t.length <= DbTableCreator._maxIdentifierLength,
                `${argName} '${trimmed}' (${trimmed.length} chars) exceeds Postgres max identifier length of ${DbTableCreator._maxIdentifierLength} and would be silently truncated`
            )
            ;

        return trimmed;
    }
}

/**
 * A {@link SnapshotIndexedPath} resolved to the expression that extracts it, so the
 * expression is built once and shared by the index DDL and the returned
 * {@link SnapshotTableInfo.indexedExpressions}.
 */
interface ResolvedIndexedPath
{
    /**
     * The path as the caller supplied it, used to key the returned expressions.
     */
    readonly path: string;

    /**
     * The extraction expression, from {@link DataHelper.createJsonPathExpression}.
     */
    readonly expression: string;

    /**
     * Whether the index over this path enforces uniqueness.
     */
    readonly isUnique: boolean;
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
}
