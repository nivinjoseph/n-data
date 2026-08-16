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
export interface SnapshotTableOptions<TState> {
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
export interface SnapshotTableInfo {
    /**
     * The created table's name.
     */
    readonly tableName: string;
    /**
     * The indexes as created, in declaration order, with their grouping and column order intact.
     *
     * **Named for what it holds, which is not what was declared.** It includes what the creator added
     * on its own - the standalone `(organization_id)` index on an org-scoped table, reported with
     * empty `paths` and that column as `leadingColumn` - and it reports a GIN index's real shape
     * rather than the declaration's. Three other things in this library are called `indexes`
     * (`SnapshotQuerySet.indexes` and `SnapshotTableOptions.indexes`, both btree declarations only,
     * and the `static readonly indexes` a repository conventionally names its query set), and this
     * was the one that meant something different.
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
 * One divergence between a set of index declarations and what a database was actually provisioned
 * with, found by the `verify*` methods on {@link DbTableCreator}.
 *
 * This is the runtime detector for the drift the compiler cannot see: creation is
 * `create ... if not exists`, which matches on **name alone** and never reconciles, so a declaration
 * changed after its migration ran - a new path, a new cast, a cleared `unique`, a scalar turned
 * array - leaves the database as it was while every query still compiles and runs. The failure mode
 * is a silent sequential scan (or a constraint still enforced against expectation), which nothing
 * raises.
 *
 * `severity` follows the same rule as `SnapshotShapeIssue`: a `fatal` issue is definite drift
 * between this declaration and this database, fixable only by a migration; an `advisory` one is
 * ambiguous or possibly deliberate - an orphan index may be the hand-built `text_pattern_ops` index
 * the docs themselves recommend, and a `gin` index over the wrong opclass still answers containment,
 * just worse. Nothing here (or anywhere in this class) alters or drops; every message names the
 * hand-written migration that would fix it.
 */
export interface SnapshotDriftIssue {
    /**
     * The table the issue is about.
     */
    readonly tableName: string;
    /**
     * The index the issue is about; absent for the table-level kinds.
     */
    readonly indexName?: string;
    /**
     * What diverged.
     *
     * - `table-missing`: the table does not exist - the migration that creates it never ran here.
     * - `column-missing`: an org-scoped declaration against a table created before the aggregate was
     *   org-scoped; `create table if not exists` never adds columns.
     * - `index-missing`: a declared index with no matching migration run - including a declaration
     *   whose derived name changed, since the old index answers to the old name.
     * - `index-uniqueness-mismatch` / `index-method-mismatch` / `index-columns-mismatch` /
     *   `index-cast-mismatch` / `index-expression-mismatch`: an index exists under the declared name
     *   but is not the declared index - reachable when `name` overrides pin a name across a changed
     *   declaration, and for casts even without one, since the derived name does not encode the cast.
     * - `index-opclass-mismatch`: a GIN index not over `jsonb_path_ops` - still serves `@>`, larger
     *   and slower.
     * - `orphan-index`: an index following this class's `idx_<table>` naming that no current
     *   declaration produces - the residue of a changed declaration, or a deliberate hand-built one.
     */
    readonly kind: "table-missing" | "column-missing" | "index-missing" | "index-uniqueness-mismatch" | "index-method-mismatch" | "index-columns-mismatch" | "index-cast-mismatch" | "index-expression-mismatch" | "index-opclass-mismatch" | "orphan-index";
    /**
     * `fatal` for definite drift a migration must fix; `advisory` for the ambiguous or possibly
     * deliberate.
     */
    readonly severity: "fatal" | "advisory";
    /**
     * Names the problem and the fix - for a missing index, the exact DDL to run - so a logged issue
     * is actionable on its own.
     */
    readonly message: string;
    /**
     * Executable DDL that remedies the issue - `create index ...` for a missing index,
     * `drop index if exists ...; create ...` for a mismatched one - for the consumer to run in the
     * *next* migration. Nothing here ever executes it; detection and remediation stay on opposite
     * sides of the door on purpose.
     *
     * Present only on a `fatal` issue whose remedy is a statement, and that boundary is the point:
     * fatal means definite drift, so handing over copy-paste DDL is safe, while an `advisory` issue
     * may be deliberate - an orphan might be the hand-built `text_pattern_ops` index the docs
     * recommend, and no caller (a coding agent least of all) should hold a ready-made `drop` for an
     * index that might be intentional. Absent also on `table-missing` (the remedy is running the
     * migration that creates the table) and `column-missing` (adding a not-null column to a
     * populated table needs a default-and-backfill decision a canned statement would get wrong).
     */
    readonly fix?: string;
}
/**
 * What a `reconcile*` call did, and what it left: the drift it mechanically fixed, and the issues
 * that remain by design rather than by failure.
 *
 * A non-empty {@link remaining} is a legitimate outcome, not an error - it holds the advisories
 * reconciliation never touches (an orphan may be deliberate) and the fatals no statement can fix
 * (a missing table means the creating migration has not run; a missing `organization_id` column
 * needs a backfill decision). An *execution* failure, by contrast, throws: recreating a unique
 * index over data that has grown duplicates raises `DbException`, with the old index intact
 * because each fix is one atomic command.
 */
export interface SnapshotReconcileResult {
    /**
     * The table that was reconciled.
     */
    readonly tableName: string;
    /**
     * The fatal issues whose {@link SnapshotDriftIssue.fix} was executed, in the order they ran.
     */
    readonly fixed: ReadonlyArray<SnapshotDriftIssue>;
    /**
     * What the closing verify still reports: advisories, and fatals with no mechanical fix. Empty
     * means the database now matches the declarations exactly.
     */
    readonly remaining: ReadonlyArray<SnapshotDriftIssue>;
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
    private static _compareIndexes;
    /**
     * The one place an index's DDL is rendered - {@link _createTable} emits it, and the plan carries
     * it for the `index-missing` message, so the fix a verify issue names is the statement creation
     * would run.
     *
     * @param {string} tableName - The validated table name.
     * @param {TableIndex} index - The index definition.
     * @returns {string} The `create index` statement.
     */
    private static _createIndexDdl;
    /**
     * The remedy for an index that exists under the declared name but is not the declared index:
     * drop it, then run the same statement creation would - the {@link ExpectedIndex.ddl} the plan
     * already carries, so the recreate provably matches what a fresh migration would build.
     *
     * @param {ExpectedIndex} expected - The index the declaration produces.
     * @returns {string} The two-statement fix.
     */
    private static _createFixDdl;
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
    createSnapshotTableForOrgAggregate<TState extends OrgAggregateState>(aggregateType: OrgAggregateRootClassOf<TState>, options?: SnapshotTableOptions<TState>): Promise<SnapshotTableInfo>;
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
    verifySnapshotTableForAggregate<TState extends AggregateState>(aggregateType: AggregateRootClassOf<TState>, options?: SnapshotTableOptions<TState>): Promise<ReadonlyArray<SnapshotDriftIssue>>;
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
    verifySnapshotTableForOrgAggregate<TState extends OrgAggregateState>(aggregateType: OrgAggregateRootClassOf<TState>, options?: SnapshotTableOptions<TState>): Promise<ReadonlyArray<SnapshotDriftIssue>>;
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
    verifyEventStreamTableForAggregate(aggregateType: AggregateRootClass): Promise<ReadonlyArray<SnapshotDriftIssue>>;
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
    verifyEventStreamTableForOrgAggregate(aggregateType: OrgAggregateRootClass): Promise<ReadonlyArray<SnapshotDriftIssue>>;
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
    reconcileSnapshotTableForAggregate<TState extends AggregateState>(aggregateType: AggregateRootClassOf<TState>, options?: SnapshotTableOptions<TState>): Promise<SnapshotReconcileResult>;
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
    reconcileSnapshotTableForOrgAggregate<TState extends OrgAggregateState>(aggregateType: OrgAggregateRootClassOf<TState>, options?: SnapshotTableOptions<TState>): Promise<SnapshotReconcileResult>;
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
    private _readOptions;
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
    private _planSnapshotTable;
    /**
     * Checks that a table exists, and on an org-scoped one that it carries the `organization_id`
     * column - the two table-level drifts, ahead of any index comparison.
     *
     * @param {string} tableName - The validated table name.
     * @param {boolean} orgScoped - Whether the declaration is org-scoped.
     * @returns {Promise<Array<SnapshotDriftIssue>>} The table-level issues found, or empty.
     */
    private _verifyTable;
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
    private _verifySnapshotTable;
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
    private _reconcileSnapshotTable;
    /**
     * Reads a table's column names from `information_schema`. Empty means the table does not exist.
     *
     * @param {string} tableName - The validated table name.
     * @returns {Promise<ReadonlyArray<string>>} The column names, in ordinal order.
     */
    private _fetchTableColumns;
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
    private _fetchTableIndexes;
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