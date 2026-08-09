import { AggregateState, OrgAggregateState } from "@nivinjoseph/n-domain";
import { Db } from "../db/db.js";
import { Logger } from "@nivinjoseph/n-log";
import { AggregateRootClass, AggregateRootClassOf, OrgAggregateRootClass, OrgAggregateRootClassOf } from "../repository/data-helper.js";
import { SnapshotArrayIndex } from "./snapshot-array-index.js";
import { SnapshotIndex } from "./snapshot-index.js";
/**
 * One index that was created over a snapshot table.
 */
export interface SnapshotTableIndexInfo {
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
     * index for the planner to BitmapAnd the GIN scan against. Constraining `organization_id` remains
     * mandatory regardless - that is tenant isolation, a correctness rule independent of the plan.
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
export interface SnapshotTableOptions<TState> {
    /**
     * Btree expression indexes over leaf scalars inside `data`.
     */
    readonly indexes?: ReadonlyArray<SnapshotIndex<TState>>;
    /**
     * GIN containment indexes over arrays inside `data`.
     */
    readonly arrayIndexes?: ReadonlyArray<SnapshotArrayIndex<TState>>;
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
     * The indexes as created, in declaration order, with their grouping and column order intact.
     *
     * Predicates are not built from here - they come from the declarations, via
     * {@link SnapshotIndex.expressionForPath}, whose expression provably matches what was indexed.
     * This is the record of what was **created**, which is not the same as what was declared: a
     * builder mutated after this call still answers for a path no index covers. Read it to see what
     * a predicate has to constrain, since a btree index only serves a leading prefix of its columns -
     * so the second path of a composite, or anything on an org-scoped table ahead of
     * `organization_id`, is not independently searchable.
     */
    readonly indexes: ReadonlyArray<SnapshotTableIndexInfo>;
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
    /**
     * The prefix every index name carries. Its length is the budget a derived table name must leave
     * free, so an index name composed over it can still fit.
     */
    private static readonly _indexNamePrefix;
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
     * @throws {ArgumentNullException} If aggregateType is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, or the derived table or index name is not a valid Postgres identifier or exceeds the identifier limit.
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
     * @throws {ArgumentNullException} If aggregateType is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, or the derived table or index name is not a valid Postgres identifier or exceeds the identifier limit.
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
     * Each entry in `indexes` produces one expression index over the keys it names inside
     * `data`; no column is added. Keep those declarations and build where clauses from them with
     * {@link SnapshotIndex.expressionForPath}, so a predicate matches what was indexed.
     *
     * `TState` is inferred from `aggregateType`, so every index's paths are checked against the
     * aggregate's real state shape.
     *
     * An array inside `data` takes the other kind: pass `SnapshotArrayIndex` declarations as
     * `arrayIndexes` on the options object, which builds a GIN containment index over the array as
     * jsonb and answers membership questions of it.
     *
     * @param {AggregateRootClassOf<TState>} aggregateType - The aggregate class whose snapshot table is created.
     * @param {ReadonlyArray<SnapshotIndex<TState>> | SnapshotTableOptions<TState>} [indexesOrOptions] - Optional btree indexes over keys within `data`, or an options object carrying those and the array indexes.
     * @returns {Promise<SnapshotTableInfo>} A promise that resolves to the table's name and the indexes as created.
     * @throws {ArgumentNullException} If aggregateType is null or undefined, or an element of indexes is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, the derived table or index name is invalid, or the indexes are invalid or duplicated.
     * @throws {DbException} If a DDL command fails.
     */
    createSnapshotTableForAggregate<TState extends AggregateState>(aggregateType: AggregateRootClassOf<TState>, indexes?: ReadonlyArray<SnapshotIndex<TState>>): Promise<SnapshotTableInfo>;
    createSnapshotTableForAggregate<TState extends AggregateState>(aggregateType: AggregateRootClassOf<TState>, options?: SnapshotTableOptions<TState>): Promise<SnapshotTableInfo>;
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
     * @param {OrgAggregateRootClassOf<TState>} aggregateType - The org-scoped aggregate class whose snapshot table is created.
     * @param {ReadonlyArray<SnapshotIndex<TState>> | SnapshotTableOptions<TState>} [indexesOrOptions] - Optional btree indexes over keys within `data`, or an options object carrying those and the array indexes.
     * @returns {Promise<SnapshotTableInfo>} A promise that resolves to the table's name and the indexes as created.
     * @throws {ArgumentNullException} If aggregateType is null or undefined, or an element of indexes is null or undefined.
     * @throws {ArgumentException} If aggregateType is not a function, the derived table or index name is invalid, or the indexes are invalid or duplicated.
     * @throws {DbException} If a DDL command fails.
     */
    createSnapshotTableForOrgAggregate<TState extends OrgAggregateState>(aggregateType: OrgAggregateRootClassOf<TState>, indexes?: ReadonlyArray<SnapshotIndex<TState>>): Promise<SnapshotTableInfo>;
    createSnapshotTableForOrgAggregate<TState extends OrgAggregateState>(aggregateType: OrgAggregateRootClassOf<TState>, options?: SnapshotTableOptions<TState>): Promise<SnapshotTableInfo>;
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
     * @throws {ArgumentException} If tableName or suffix is not a string, tableName is empty or whitespace, or the resulting index name fails {@link validateIndexName}.
     */
    createIndexNameFromTableName(tableName: string, suffix?: string): string;
    /**
     * Resolves the two accepted second-argument shapes into one.
     *
     * The bare array is the original signature and stays supported: every existing migration passes
     * one. The object form is what a second index kind needs, and what a third would extend.
     *
     * @param {ReadonlyArray<SnapshotIndex<any>> | SnapshotTableOptions<any>} [value] - The caller's second argument.
     * @returns {SnapshotTableOptions<any>} The two collections, either of which may be absent.
     * @throws {ArgumentException} If value is neither an array nor an object.
     */
    private _normalizeOptions;
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
    private _validateIndexes;
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
    private _planIndexes;
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
    private _validateIdentifier;
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
    private _validateTableName;
}
//# sourceMappingURL=db-table-creator.d.ts.map