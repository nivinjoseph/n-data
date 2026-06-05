import { Db } from "../db/db.js";
import { Logger } from "@nivinjoseph/n-log";
import { AggregateRootClass, OrgAggregateRootClass } from "../repository/data-helper.js";
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
     * @throws {Error} If the derived index name exceeds the Postgres identifier limit, or if a DDL command fails.
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
     * @throws {Error} If the derived index name exceeds the Postgres identifier limit, or if a DDL command fails.
     */
    createEventStreamTableForOrgAggregate(aggregateType: OrgAggregateRootClass): Promise<string>;
    /**
     * Creates the snapshot table for a plain aggregate.
     *
     * The snapshot table holds the latest materialized state of each aggregate, keyed by its
     * `id` (the primary key, which is already indexed — so no secondary index is created).
     * Optional `extraColumns` are injected as additional column definitions, allowing callers
     * to project fields out of the snapshot for querying. The table name is derived via
     * {@link DataHelper.createSnapshotTableName}.
     *
     * @param {AggregateRootClass} aggregateType - The aggregate class whose snapshot table is created.
     * @param {ReadonlyArray<string>} [extraColumns] - Optional raw column definitions (e.g. `"status varchar(20) not null"`) inserted before the `data` column. Trusted input — interpolated directly into the DDL.
     * @returns {Promise<string>} A promise that resolves to the created table's name once the table exists.
     * @throws {Error} If a DDL command fails.
     */
    createSnapshotTableForAggregate(aggregateType: AggregateRootClass, extraColumns?: ReadonlyArray<string>): Promise<string>;
    /**
     * Creates the snapshot table and its index for an organization-scoped aggregate.
     *
     * Like {@link createSnapshotTableForAggregate} but adds a non-null `organization_id`
     * column and an index on `(organization_id, id)` to support org-scoped lookups.
     *
     * @param {OrgAggregateRootClass} aggregateType - The org-scoped aggregate class whose snapshot table is created.
     * @param {ReadonlyArray<string>} [extraColumns] - Optional raw column definitions inserted before the `data` column. Trusted input — interpolated directly into the DDL.
     * @returns {Promise<string>} A promise that resolves to the created table's name once the table and index exist.
     * @throws {Error} If the derived index name exceeds the Postgres identifier limit, or if a DDL command fails.
     */
    createSnapshotTableForOrgAggregate(aggregateType: OrgAggregateRootClass, extraColumns?: ReadonlyArray<string>): Promise<string>;
    /**
     * Validates an index name against Postgres's constraints and returns it trimmed.
     *
     * Ensures the name is a non-empty string, carries the `idx_` prefix convention, and does
     * not exceed the Postgres identifier limit (63 bytes) — which would otherwise cause the
     * name to be silently truncated, risking collisions or a skipped index.
     *
     * @param {string} indexName - The candidate index name to validate.
     * @returns {string} The validated, trimmed index name.
     * @throws {ArgumentException} If the name is empty, missing the `idx_` prefix, or too long.
     */
    validateIndexName(indexName: string): string;
    /**
     * Builds the conventional `idx_<tableName>` index name and validates it.
     *
     * @param {string} tableName - The table the index belongs to.
     * @returns {string} The validated index name.
     * @throws {ArgumentException} If the resulting index name fails {@link validateIndexName}.
     */
    private _createIndexNameFromTableName;
    /**
     * Normalizes optional extra column definitions into a DDL-ready fragment.
     *
     * Empty/whitespace entries are dropped, each entry is trimmed and given a trailing comma
     * (so it can be spliced before the `data` column), and the entries are joined into a
     * single string. Returns an empty string when there are no columns.
     *
     * @param {ReadonlyArray<string>} [extraColumns] - Optional raw column definitions.
     * @returns {string} A comma-terminated DDL fragment, or `""` if none.
     */
    private _formatExtraColumns;
}
//# sourceMappingURL=db-table-creator.d.ts.map