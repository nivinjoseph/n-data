import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "../repository/data-helper.js";
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
export class DbTableCreator {
    /**
     * Maximum identifier length Postgres permits before silently truncating.
     * Postgres truncates identifiers to NAMEDATALEN - 1 = 63 bytes.
     */
    static _maxIdentifierLength = 63;
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
     * @throws {Error} If the derived index name exceeds the Postgres identifier limit, or if a DDL command fails.
     */
    async createEventStreamTableForAggregate(aggregateType) {
        const tableName = DataHelper.createEventStreamTableName(aggregateType);
        const indexName = this._createIndexNameFromTableName(tableName);
        await this._db.executeCommand(`
            create table if not exists ${tableName}
            (
                id varchar(50) primary key,
                aggregate_id varchar(40) not null,
                aggregate_version integer not null,
                data jsonb not null
            );
        `);
        await this._db.executeCommand(`
            create unique index if not exists ${indexName} on ${tableName}(aggregate_id, aggregate_version);
        `);
        await this._logger.logInfo(`TABLE CREATED [${tableName}]`);
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
     * @throws {Error} If the derived index name exceeds the Postgres identifier limit, or if a DDL command fails.
     */
    async createEventStreamTableForOrgAggregate(aggregateType) {
        const tableName = DataHelper.createEventStreamTableName(aggregateType);
        const indexName = this._createIndexNameFromTableName(tableName);
        await this._db.executeCommand(`
            create table if not exists ${tableName}
            (
                id varchar(50) primary key,
                aggregate_id varchar(40) not null,
                aggregate_version integer not null,
                organization_id varchar(40) not null,
                data jsonb not null
            );
        `);
        await this._db.executeCommand(`
            create unique index if not exists ${indexName} on ${tableName}(organization_id, aggregate_id, aggregate_version);
        `);
        await this._logger.logInfo(`TABLE CREATED [${tableName}]`);
        return tableName;
    }
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
    async createSnapshotTableForAggregate(aggregateType, extraColumns) {
        const tableName = DataHelper.createSnapshotTableName(aggregateType);
        await this._db.executeCommand(`
            create table if not exists ${tableName}
            (
                id varchar(40) primary key,
                ${this._formatExtraColumns(extraColumns)}
                data jsonb not null
            );
        `);
        await this._logger.logInfo(`TABLE CREATED [${tableName}]`);
        return tableName;
    }
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
    async createSnapshotTableForOrgAggregate(aggregateType, extraColumns) {
        const tableName = DataHelper.createSnapshotTableName(aggregateType);
        const indexName = this._createIndexNameFromTableName(tableName);
        await this._db.executeCommand(`
            create table if not exists ${tableName}
            (
                id varchar(40) primary key,
                organization_id varchar(40) not null,
                ${this._formatExtraColumns(extraColumns)}
                data jsonb not null
            );
        `);
        await this._db.executeCommand(`
            create index if not exists ${indexName} on ${tableName}(organization_id, id);
        `);
        await this._logger.logInfo(`TABLE CREATED [${tableName}]`);
        return tableName;
    }
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
    validateIndexName(indexName) {
        given(indexName, "indexName").ensureHasValue().ensureIsString()
            .ensure(t => t.isNotEmptyOrWhiteSpace())
            .ensure(t => t.trim().startsWith("idx_"))
            .ensure(t => t.trim().length <= DbTableCreator._maxIdentifierLength, `index name '${indexName}' (${indexName.length} chars) exceeds Postgres max identifier length of ${DbTableCreator._maxIdentifierLength} and would be silently truncated`);
        return indexName.trim();
    }
    /**
     * Builds the conventional `idx_<tableName>` index name and validates it.
     *
     * @param {string} tableName - The table the index belongs to.
     * @returns {string} The validated index name.
     * @throws {ArgumentException} If the resulting index name fails {@link validateIndexName}.
     */
    _createIndexNameFromTableName(tableName) {
        const indexName = `idx_${tableName}`;
        return this.validateIndexName(indexName);
    }
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
    _formatExtraColumns(extraColumns) {
        given(extraColumns, "extraColumns").ensureIsArray();
        if (extraColumns == null || extraColumns.isEmpty)
            return "";
        return extraColumns
            .where(t => t.isNotEmptyOrWhiteSpace())
            .map(t => t.trim())
            .map(t => t.endsWith(",") ? t : t + ",")
            .join(" ");
    }
}
//# sourceMappingURL=db-table-creator.js.map