import { ReadModelColumnInfo } from "./read-model-schema.js";
/**
 * The two directions between a model instance and a row, and the statements that carry them.
 *
 * Writing is direct: every value is read off the instance by property access - never through
 * `serialize()`, so a `@serialize("customKey")` rename cannot move a column - and bound as it is,
 * arrays included (pg serializes a JS array as a Postgres array literal). The one conversion is
 * `timestamptz`, whose placeholder is `to_timestamp(? / 1000.0)` so the bound value stays the plain
 * epoch-millisecond number.
 *
 * Reading normalizes what pg hands back with no custom type parsers installed: `bigint` and
 * `numeric` arrive as strings, `bigint[]` as strings, `timestamptz` as a `Date`. The row is read by
 * column name and only the declared columns are copied into the constructor data, stamped with the
 * class's registered `$typename` exactly as the deserializer stamps a stored artifact - a hydration
 * IS a deserialization, so the class's constructor admits it on the same terms.
 *
 * Internal: built once per repository instance from its schema.
 */
export declare class ReadModelRowMapper {
    private readonly _table;
    private readonly _typeName;
    private readonly _columns;
    private readonly _selectList;
    private readonly _upsertHead;
    private readonly _rowTerms;
    private readonly _upsertTail;
    private readonly _upsertSql;
    private readonly _upsertSqlByRowCount;
    private readonly _deleteSql;
    /**
     * `id, <column>, ...` - every declared column, in declaration order.
     */
    get selectList(): string;
    /**
     * The single-row upsert: an insert of every column, `on conflict (id) do update` setting each
     * from `excluded`. One row is always affected, which is what keeps the driver's affected-row
     * check satisfied on both paths.
     */
    get upsertSql(): string;
    get deleteSql(): string;
    /**
     * How many rows one multi-row upsert may carry: Postgres binds at most 65535 parameters per
     * statement, and each row binds `id` plus one per column - capped at 500, past which a statement
     * gains nothing and only grows.
     */
    get chunkSize(): number;
    constructor(table: string, typeName: string, columns: ReadonlyArray<ReadModelColumnInfo>);
    /**
     * The upsert for `rowCount` rows: one value tuple per row, each binding `id` and then every
     * column through its own term, so the parameters are the rows' {@link toParams} results
     * concatenated in row order. `rowCount` rows are always affected. Rendered once per row count
     * and remembered - a batch only ever asks for the chunk size and one remainder.
     *
     * @throws {ArgumentException} If rowCount is not a positive integer within {@link chunkSize}.
     */
    upsertSqlFor(rowCount: number): string;
    /**
     * The values the upsert binds, positionally: the id, then one per column in declaration order.
     * `undefined` binds as NULL, like `null` does; an array is copied so a frozen one binds too.
     */
    toParams(model: object): Array<unknown>;
    /**
     * The constructor data a row hydrates into: `id` and every declared column under its key, each
     * normalized to the property's kind.
     *
     * @throws {ApplicationException} If the row lacks `id` or a declared column (the `queryStatement` contract), or a value cannot be normalized - a bigint beyond the safe integer range, a timestamp that is not a Date.
     */
    toData(row: Record<string, unknown>): Record<string, unknown>;
    private _normalize;
    private _normalizeScalar;
}
//# sourceMappingURL=read-model-row-mapper.d.ts.map