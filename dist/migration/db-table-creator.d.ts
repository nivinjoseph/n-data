import { Db } from "../db/db.js";
import { Logger } from "@nivinjoseph/n-log";
import { AggregateRootClass, JsonValueType, OrgAggregateRootClass } from "../repository/data-helper.js";
/**
 * A key inside a snapshot table's `data` column to build an expression index over.
 *
 * No column is added to the table for this; the index is built directly over the extraction
 * expression. That keeps it retrievable on tables that already exist (an index is created
 * independently of the table, whereas adding a column would need an alter that
 * `create table if not exists` never issues) and keeps the row narrow.
 */
export interface SnapshotIndexedPath {
    /**
     * The key within `data`; dot delimited to reach a nested key, e.g. `"customer.city"`.
     */
    readonly path: string;
    /**
     * Optional type to cast the extracted text to. Supply it whenever the value is not a
     * string: an uncast comparison orders lexicographically, making '9' > '100' true.
     */
    readonly type?: JsonValueType;
}
/**
 * The result of creating a snapshot table.
 */
export interface SnapshotTableInfo {
    /**
     * The created table's name.
     */
    readonly tableName: string;
    /**
     * The indexed expressions, keyed by the `path` they were built from. Build where clauses
     * from these so they match the indexed expressions - Postgres only uses an expression
     * index when the query expression matches, so divergence silently costs a seq scan.
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
export declare class DbTableCreator {
    /**
     * Maximum identifier length Postgres permits before silently truncating.
     * Postgres truncates identifiers to NAMEDATALEN - 1 = 63 bytes.
     */
    private static readonly _maxIdentifierLength;
    /**
     * An unquoted Postgres identifier that needs no folding: lowercase, digits, underscores.
     * Anything else would either be truncated, folded, or change the statement's meaning
     * once interpolated into DDL.
     */
    private static readonly _identifierRegex;
    private readonly _db;
    private readonly _logger;
    /**
     * Creates a new DbTableCreator.
     *
     * @param {Db} db - The writable database used to execute the DDL commands.
     * @param {Logger} logger - The logger used to record each table creation.
     */
    constructor(db: Db, logger: Logger);
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
    createEventStreamTableForAggregate(aggregateType: AggregateRootClass): Promise<string>;
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
    createEventStreamTableForOrgAggregate(aggregateType: OrgAggregateRootClass): Promise<string>;
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
    createSnapshotTableForAggregate(aggregateType: AggregateRootClass, indexedPaths?: ReadonlyArray<SnapshotIndexedPath>): Promise<SnapshotTableInfo>;
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
    createSnapshotTableForOrgAggregate(aggregateType: OrgAggregateRootClass, indexedPaths?: ReadonlyArray<SnapshotIndexedPath>): Promise<SnapshotTableInfo>;
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
    validateIndexName(indexName: string): string;
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
    createIndexNameFromTableName(tableName: string, suffix?: string): string;
    /**
     * Creates a table and its indexes, all idempotently.
     *
     * @param {string} tableName - The table to create.
     * @param {ReadonlyArray<string>} columns - The column definitions, in order.
     * @param {ReadonlyArray<TableIndex>} [indexes] - The indexes to create over the table.
     * @returns {Promise<void>} A promise that resolves once the table and indexes exist.
     */
    private _createTable;
    /**
     * Builds the json path expression for each indexed path, keyed by its path.
     *
     * @param {ReadonlyArray<SnapshotIndexedPath>} [indexedPaths] - The paths to build expressions for.
     * @returns {Record<string, string>} The expressions, keyed by path; empty when there are none.
     * @throws {InvalidArgumentException} If a path or type is malformed, or two paths are the same.
     */
    private _createIndexedExpressions;
    /**
     * Turns indexed expressions into index definitions, one per expression.
     *
     * The index name is derived from the path so it is stable and readable, and so two paths
     * on one table cannot land on the same index name - which `if not exists` would silently
     * skip rather than report.
     *
     * @param {string} tableName - The table the indexes belong to.
     * @param {Readonly<Record<string, string>>} indexedExpressions - The expressions, keyed by path.
     * @param {string} [leadingColumn] - Optional column to lead each index with.
     * @returns {Array<TableIndex>} The index definitions; empty when there are no expressions.
     * @throws {InvalidArgumentException} If two paths derive the same index name.
     */
    private _createExpressionIndexes;
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
    private _validateIdentifier;
}
//# sourceMappingURL=db-table-creator.d.ts.map