import { given } from "@nivinjoseph/n-defensive";
import { ApplicationException } from "@nivinjoseph/n-exception";
import { bindingTermOf, ColumnType, elementTypeOf, isArrayColumnType } from "./column-type.js";
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
export class ReadModelRowMapper {
    _table;
    _typeName;
    _columns;
    _selectList;
    _upsertSql;
    _deleteSql;
    /**
     * `id, <column>, ...` - every declared column, in declaration order.
     */
    get selectList() { return this._selectList; }
    /**
     * The upsert: an insert of every column, `on conflict (id) do update` setting each from
     * `excluded`. One row is always affected, which is what keeps the driver's affected-row check
     * satisfied on both paths.
     */
    get upsertSql() { return this._upsertSql; }
    get deleteSql() { return this._deleteSql; }
    constructor(table, typeName, columns) {
        given(table, "table").ensureHasValue().ensureIsString();
        this._table = table.trim();
        given(typeName, "typeName").ensureHasValue().ensureIsString();
        this._typeName = typeName;
        given(columns, "columns").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        this._columns = [...columns];
        const names = this._columns.map(t => t.column);
        this._selectList = ["id", ...names].join(", ");
        this._upsertSql = `insert into ${this._table}
                            (id, ${names.join(", ")})
                            values (?, ${this._columns.map(t => bindingTermOf(t.type)).join(", ")})
                            on conflict (id) do update
                            set ${names.map(t => `${t} = excluded.${t}`).join(", ")};`;
        this._deleteSql = `delete from ${this._table} where id = ?;`;
    }
    /**
     * The values the upsert binds, positionally: the id, then one per column in declaration order.
     * `undefined` binds as NULL, like `null` does; an array is copied so a frozen one binds too.
     */
    toParams(model) {
        given(model, "model").ensureHasValue().ensureIsObject();
        const record = model;
        return [record["id"], ...this._columns.map(t => {
                const value = record[t.key];
                if (value == null)
                    return null;
                return Array.isArray(value) ? [...value] : value;
            })];
    }
    /**
     * The constructor data a row hydrates into: `id` and every declared column under its key, each
     * normalized to the property's kind.
     *
     * @throws {ApplicationException} If the row lacks `id` or a declared column (the `queryStatement` contract), or a value cannot be normalized - a bigint beyond the safe integer range, a timestamp that is not a Date.
     */
    toData(row) {
        given(row, "row").ensureHasValue().ensureIsObject();
        const id = row["id"];
        if (typeof id !== "string")
            throw new ApplicationException(`a row from '${this._table}' carries no 'id' column - select it, or select *`);
        const data = { $typename: this._typeName, id };
        for (const column of this._columns) {
            const value = row[column.column];
            // undefined is "not selected", which is a statement bug; null is a stored NULL
            if (value === undefined)
                throw new ApplicationException(`a row from '${this._table}' carries no '${column.column}' column (key '${column.key}') - select every declared column, or select *`);
            data[column.key] = value === null ? null : this._normalize(column, value);
        }
        return data;
    }
    _normalize(column, value) {
        if (!isArrayColumnType(column.type))
            return this._normalizeScalar(column, column.type, value);
        if (!Array.isArray(value))
            throw new ApplicationException(`column '${column.column}' of '${this._table}' came back as ${typeof value}, not as an array`);
        const element = elementTypeOf(column.type);
        // a NULL element can only come from a hand-written statement; it is passed through rather than
        // dropped, so the class's own guards see what is stored
        return value.map(t => t === null ? null : this._normalizeScalar(column, element, t));
    }
    _normalizeScalar(column, type, value) {
        switch (type) {
            case ColumnType.bigint:
                {
                    const parsed = typeof value === "number" ? value : Number(value);
                    if (!Number.isSafeInteger(parsed))
                        throw new ApplicationException(`column '${column.column}' of '${this._table}' holds ${String(value)}, which is outside the safe integer range a JavaScript number carries exactly`);
                    return parsed;
                }
            case ColumnType.numeric:
            case ColumnType.smallint:
            case ColumnType.integer:
            case ColumnType.real:
            case ColumnType.doublePrecision:
                {
                    const parsed = typeof value === "number" ? value : Number(value);
                    if (!Number.isFinite(parsed))
                        throw new ApplicationException(`column '${column.column}' of '${this._table}' holds ${String(value)}, which is not a finite number`);
                    return parsed;
                }
            case ColumnType.timestamptz:
                {
                    if (value instanceof Date)
                        return value.valueOf();
                    if (typeof value === "number")
                        return value;
                    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
                    if (!Number.isNaN(parsed))
                        return parsed;
                    throw new ApplicationException(`column '${column.column}' of '${this._table}' came back as ${typeof value}, not as a Date - a custom pg type parser for timestamptz is in the way`);
                }
            default:
                return value;
        }
    }
}
//# sourceMappingURL=read-model-row-mapper.js.map