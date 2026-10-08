import { Db } from "../db/db.js";
/**
 * The DDL mechanics every table creator in this library shares: identifier validation, index naming
 * and rendering, and the two catalog reads a drift check starts from.
 *
 * Free functions rather than a base class, so `DbTableCreator` (snapshot and event stream tables)
 * and `ReadModelTableCreator` (read model tables) can share them without either inheriting the
 * other's public surface. Internal: absent from the barrel.
 */
/**
 * Maximum identifier length Postgres permits before silently truncating.
 * Postgres truncates identifiers to NAMEDATALEN - 1 = 63 bytes.
 */
export declare const maxIdentifierLength = 63;
/**
 * An unquoted Postgres identifier that needs no folding: lowercase, digits, underscores.
 * Anything else would either be truncated, folded, or change the statement's meaning
 * once interpolated into DDL.
 */
export declare const identifierRegex: RegExp;
/**
 * The prefix every index name carries. Its length is the budget a derived table name must leave
 * free, so an index name composed over it can still fit.
 */
export declare const indexNamePrefix = "idx_";
/**
 * An index to create over a table.
 */
export interface TableIndex {
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
     * identifier the creators emit is validated. A union costs nothing and is checked at compile time.
     */
    readonly method?: "gin";
}
/**
 * One index as the catalog describes it - the row shape {@link fetchTableIndexes} selects.
 */
export interface ActualTableIndex {
    /**
     * `pg_class.relname` of the index.
     */
    readonly indexName: string;
    /**
     * `pg_index.indisunique`.
     */
    readonly isUnique: boolean;
    /**
     * `pg_am.amname` - `btree`, `gin`, ...
     */
    readonly method: string;
    /**
     * `pg_index.indnatts` - real columns and expression columns both count.
     */
    readonly columnCount: number;
    /**
     * `format_type()` per column, in column order. For a btree expression column this is the
     * **expression's result type** - the parse tree's answer, not printed text - which is what makes
     * a declared cast comparable exactly. For a GIN column it is the opclass *storage* type
     * (`integer` for `jsonb_path_ops` hashes), so the cast comparison is btree-only.
     */
    readonly columnTypes: ReadonlyArray<string>;
    /**
     * `pg_get_indexdef(oid, n, true)` per column: the pretty-printed column definition. For an
     * expression column, compare by token containment only - Postgres normalizes expression text;
     * for a plain column it is the bare column name.
     */
    readonly columnDefs: ReadonlyArray<string>;
    /**
     * `pg_get_indexdef(oid)` - the whole statement, used only to see the opclass, which no
     * column-level accessor reports.
     */
    readonly indexDef: string;
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
export declare function validateIdentifier(value: string, argName: string, maxLength?: number): string;
/**
 * Validates a derived table name, budgeting for the index names composed over it.
 *
 * Every index the creators build is named `idx_<tableName>[_<suffix>]`, so a table name that uses
 * the full 63 characters leaves no room for one. Validating against the reduced budget here means an
 * overlong class name is reported against `tableName` - the identifier actually at fault - rather
 * than against a derived `indexName` further downstream.
 *
 * @param {string} tableName - The derived table name.
 * @returns {string} The validated, trimmed table name.
 * @throws {ArgumentNullException} If tableName is null or undefined.
 * @throws {ArgumentException} If tableName is not a string, is empty or whitespace, is not a valid identifier, or leaves no room for an index name.
 */
export declare function validateTableName(tableName: string): string;
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
export declare function validateIndexName(indexName: string): string;
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
export declare function createIndexName(tableName: string, suffix?: string): string;
/**
 * The one place an index's DDL is rendered - table creation emits it, and a drift plan carries it
 * for the `index-missing` message, so the fix a verify issue names is the statement creation would
 * run.
 *
 * @param {string} tableName - The validated table name.
 * @param {TableIndex} index - The index definition.
 * @returns {string} The `create index` statement.
 */
export declare function createIndexDdl(tableName: string, index: TableIndex): string;
/**
 * Reads a table's column names from `information_schema`. Empty means the table does not exist.
 *
 * @param {Db} db - The database to read the catalog of.
 * @param {string} tableName - The validated table name.
 * @returns {Promise<ReadonlyArray<string>>} The column names, in ordinal order.
 */
export declare function fetchTableColumnNames(db: Db, tableName: string): Promise<ReadonlyArray<string>>;
/**
 * Reads every index on a table from `pg_catalog`, structurally rather than as definition text.
 *
 * Per index: name, uniqueness, access method, column count, and per column the **result type**
 * (`format_type` over `pg_attribute` - for an expression column that is the expression's type,
 * which is what makes a cast comparable exactly, independent of how Postgres prints the
 * expression) and the pretty-printed column definition (`pg_get_indexdef` with a column number -
 * for an expression column usable only for token containment, never equality, because Postgres
 * normalizes expression text: `(data->>'status')` comes back as `((data ->> 'status'::text))` and a
 * quoted path array loses its quotes).
 *
 * @param {Db} db - The database to read the catalog of.
 * @param {string} tableName - The validated table name.
 * @returns {Promise<ReadonlyArray<ActualTableIndex>>} Every index on the table.
 */
export declare function fetchTableIndexes(db: Db, tableName: string): Promise<ReadonlyArray<ActualTableIndex>>;
/**
 * What every expected index carries, whichever creator declared it: the join key against the
 * catalog, the two facts the shared comparison reads, and the statement that creates it.
 */
export interface ExpectedIndexBase {
    readonly name: string;
    readonly isUnique: boolean;
    readonly method: "btree" | "gin";
    readonly ddl: string;
}
/**
 * The family-specific halves of an index comparison: how each divergence is reported, and the
 * column comparison itself - a snapshot index compares cast result types and path tokens, a read
 * model index compares bare column names and the full definition.
 */
export interface IndexComparisonHooks<TExpected extends ExpectedIndexBase, TIssue> {
    missing(expected: TExpected): TIssue;
    methodMismatch(expected: TExpected, actual: ActualTableIndex): TIssue;
    uniquenessMismatch(expected: TExpected, actual: ActualTableIndex): TIssue;
    columns(expected: TExpected, actual: ActualTableIndex): ReadonlyArray<TIssue>;
    orphan(actual: ActualTableIndex): TIssue;
}
/**
 * The remedy for an index that exists under the declared name but is not the declared index: drop
 * it, then run the same statement creation would, so the recreate provably matches what a fresh
 * migration would build.
 */
export declare function createFixDdl(expected: {
    readonly name: string;
    readonly ddl: string;
}): string;
/**
 * Compares expected indexes against what the catalog holds, name by name - the skeleton both
 * creators share, pure and synchronous. A missing index or one under another access method is
 * reported and skipped (the finer checks would only restate it); a uniqueness divergence is reported
 * and the column comparison still runs; every leftover index carrying the `idx_<table>` prefix is
 * reported as an orphan.
 */
export declare function compareIndexes<TExpected extends ExpectedIndexBase, TIssue>(tableName: string, expected: ReadonlyArray<TExpected>, actual: ReadonlyArray<ActualTableIndex>, hooks: IndexComparisonHooks<TExpected, TIssue>): Array<TIssue>;
//# sourceMappingURL=table-ddl.d.ts.map