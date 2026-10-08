/**
 * The Postgres column types a read model property can be stored as.
 *
 * The values are the DDL spellings, exactly as `JsonValueType` spells its casts, so a column
 * definition is `<column> <type>` with nothing in between - and so drift verification can compare
 * the catalog's `format_type` against them directly, with one documented exception
 * ({@link catalogTypeOf}).
 *
 * Which members fit which property type is decided at compile time by the schema declaration: a
 * `string` takes {@link text}; a `number` takes any numeric kind or {@link timestamptz}; a `boolean`
 * takes {@link boolean}; an array of one of those takes the matching array kind. There is
 * deliberately no `varchar` (a length that buys nothing over `text`), no `uuid` (an n-domain id is a
 * prefixed ULID, not a UUID), and no `timestamptz[]`.
 *
 * {@link timestamptz} is the one kind whose stored form differs from the property: the property is
 * epoch milliseconds, written as `to_timestamp(? / 1000.0)` and read back through `Date.valueOf()`,
 * so a row carries a real timestamp that `date_trunc`, ranges and time-bucket analytics can use.
 */
export declare enum ColumnType {
    text = "text",
    boolean = "boolean",
    smallint = "smallint",
    integer = "integer",
    bigint = "bigint",
    numeric = "numeric",
    real = "real",
    doublePrecision = "double precision",
    timestamptz = "timestamptz",
    textArray = "text[]",
    booleanArray = "boolean[]",
    integerArray = "integer[]",
    bigintArray = "bigint[]",
    numericArray = "numeric[]",
    doublePrecisionArray = "double precision[]"
}
/**
 * The {@link ColumnType} members a `number` property may be stored as, {@link ColumnType.timestamptz}
 * aside.
 */
export type ReadModelNumericType = ColumnType.smallint | ColumnType.integer | ColumnType.bigint | ColumnType.numeric | ColumnType.real | ColumnType.doublePrecision;
/**
 * Whether a value is a {@link ColumnType} member - the guard for a JavaScript caller, or an `any`,
 * handing the schema a stray string.
 */
export declare function isColumnType(value: unknown): value is ColumnType;
/**
 * Whether the type is one of the array kinds, which take a GIN index and the containment predicates.
 */
export declare function isArrayColumnType(type: ColumnType): boolean;
/**
 * The element kind of an array column type.
 *
 * @throws {ArgumentException} If the type is not an array kind.
 */
export declare function elementTypeOf(type: ColumnType): ColumnType;
/**
 * The spelling `format_type` prints for a column of this type - what drift verification compares
 * the catalog against. Identical to the DDL spelling for every kind but {@link ColumnType.timestamptz},
 * which Postgres prints in full.
 */
export declare function catalogTypeOf(type: ColumnType): string;
/**
 * Whether an identifier is a Postgres keyword that cannot be a bare column name.
 */
export declare function isReservedWord(identifier: string): boolean;
/**
 * The placeholder a value for a column of this type binds through. A `timestamptz` column converts
 * the epoch milliseconds on the parameter side, so the column itself stays bare and its btree
 * usable; everything else binds as it is.
 */
export declare function bindingTermOf(type: ColumnType): string;
//# sourceMappingURL=column-type.d.ts.map